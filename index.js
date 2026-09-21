import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-agent-extension'
export const inject = ['commands', 'skills', 'agents']

const MAX_NESTING_DEPTH = 6
const COMMANDS_DIR = 'commands'
const SKILLS_DIR = 'skills'
const RULES_DIR = 'rules'
const PROJECT_DSH_RANK = 50
const PROJECT_AGENTS_RANK = 100
const USER_DSH_RANK = 150
const USER_AGENTS_RANK = 200

export function apply(ctx, config = {}) {
  const discovery = new WorkspaceDiscovery(ctx, config)

  ctx.skills.registerProvider((control) => {
    discovery.setInvalidate(control.invalidate)
    control.signal.addEventListener('abort', () => discovery.dispose(), { once: true })
    return discovery
  })

  const register = (agent) => {
    try {
      discovery.registerCommandsFor(agent)
    } catch (error) {
      ctx.logger.warn(`[${name}] command discovery failed: ${message(error)}`)
    }
  }

  // Register the launch workspace immediately so existing sessions do not keep an empty UI cache.
  ctx.commands.register({
    name: 'dsh-extension-status',
    description: 'Show dsh-agent-extension discovery status',
    handler: () => ({ kind: 'success', text: discovery.statusText(process.cwd()) }),
  })
  discovery.registerGlobalCommands(process.cwd())
  ctx.on('agent/created', ({ agent }) => register(agent))
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const rules = discovery.rulesForStep(agent, messages)
    if (rules.length === 0) return decision
    return { ...decision, messages: [...decision.messages, discovery.ruleMessage(rules)] }
  })
  ctx.on('tools/result', (exec, result) => {
    if (result.isError || exec.agent === undefined || exec.signal.aborted) return
    const path = filePathFromToolExecution(exec)
    if (path !== undefined) discovery.recordTouchedPath(exec.agent, path)
  })
  ctx.on('agent/disposed', ({ agent }) => discovery.unregisterCommandsFor(agent.id))
  for (const agent of ctx.agents.list()) register(agent)
}

export class WorkspaceDiscovery {
  constructor(ctx, config) {
    this.ctx = ctx
    this.maxDepth = positiveInteger(config.maxDepth, MAX_NESTING_DEPTH)
    this.dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
    this.agentsHome = resolve(config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))
    this.commandDisposers = new Map()
    this.globalCommandDisposers = []
    this.ruleState = new WeakMap()
    this.invalidate = undefined
  }

  get name() {
    return name
  }

  setInvalidate(invalidate) {
    this.invalidate = invalidate
  }

  async list(options = {}) {
    const roots = await this.skillRoots(options.cwd)
    const candidates = []
    for (const root of roots) {
      for (const file of await discoverSkillFiles(root.path, this.maxDepth)) {
        const parsed = await parseSkill(file)
        if (!parsed) continue
        candidates.push({
          ...parsed,
          provider: name,
          source: root.source,
          rank: root.rank,
          locator: { path: file, directory: dirname(file) },
          path: file,
          resourceBase: { kind: 'directory', path: dirname(file) },
        })
      }
    }
    return candidates
  }

  async get(candidate) {
    const parsed = await parseSkill(candidate.locator.path)
    if (!parsed) return undefined
    return {
      ...parsed,
      provider: name,
      source: candidate.source,
      path: candidate.locator.path,
      resourceBase: { kind: 'directory', path: candidate.locator.directory },
    }
  }

  unregisterCommandsFor(agentId) {
    const previous = this.commandDisposers.get(agentId)
    if (previous) previous()
    this.commandDisposers.delete(agentId)
  }

  registerGlobalCommands(cwd) {
    for (const dispose of this.globalCommandDisposers.reverse()) dispose()
    this.globalCommandDisposers = []
    for (const command of this.discoverCommands(cwd).values()) {
      this.globalCommandDisposers.push(this.ctx.commands.register({
        name: command.name,
        description: command.description,
        input: { hint: '[arguments]' },
        handler: (invocation) => this.executeCommand(command, invocation),
      }))
    }
  }

  statusText(cwd) {
    const commands = this.discoverCommands(cwd)
    const roots = this.commandRootsSync(cwd).map((root) => root.path)
    return [
      'dsh-agent-extension is loaded.',
      `Working directory: ${cwd}`,
      `Scanned roots: ${roots.join(', ')}`,
      `Discovered commands (${commands.size}): ${[...commands.keys()].join(', ') || '(none)'}`,
    ].join('\n')
  }

  discoverCommands(cwd) {
    const definitions = new Map()
    for (const root of this.commandRootsSync(cwd)) {
      for (const file of discoverMarkdownFilesSync(root.path, this.maxDepth)) {
        const command = parseCommandSync(file)
        if (!command) continue
        if (!definitions.has(command.name)) definitions.set(command.name, command)
      }
    }
    return definitions
  }

  registerCommandsFor(agent) {
    this.unregisterCommandsFor(agent.id)
    const definitions = this.discoverCommands(agent.session.header.cwd)
    const disposers = []
    for (const command of definitions.values()) {
      try {
        disposers.push(agent.ctx.commands.register({
          name: command.name,
          description: command.description,
          input: { hint: '[arguments]' },
          handler: (invocation) => this.executeCommand(command, invocation),
        }))
      } catch (error) {
        this.ctx.logger.warn(`[${name}] /${command.name} from ${command.path} ignored: ${message(error)}`)
      }
    }
    this.commandDisposers.set(agent.id, () => disposers.reverse().forEach((dispose) => dispose()))
  }

  recordTouchedPath(agent, path) {
    const cwd = agent.session.header.cwd ?? process.cwd()
    const projectRoot = findProjectRootSync(resolve(cwd))
    const state = this.ruleState.get(agent.session) ?? { loaded: new Set(), touched: new Set() }
    state.touched.add(normalizeWorkspacePath(path, projectRoot))
    this.ruleState.set(agent.session, state)
  }

  rulesForStep(agent, messages) {
    const cwd = agent.session.header.cwd ?? process.cwd()
    const state = this.ruleState.get(agent.session) ?? { loaded: new Set(), touched: new Set() }
    for (const message of messages) {
      for (const path of pathsMentioned(message)) state.touched.add(normalizeWorkspacePath(path, cwd))
    }
    const selected = []
    for (const rule of this.discoverRules(cwd).values()) {
      if (state.loaded.has(rule.path)) continue
      if (rule.paths.length === 0 || [...state.touched].some((path) => rule.paths.some((pattern) => globMatches(pattern, path)))) {
        state.loaded.add(rule.path)
        selected.push(rule)
      }
    }
    this.ruleState.set(agent.session, state)
    return selected
  }

  ruleMessage(rules) {
    const content = [
      '<workspace_rules>',
      ...rules.flatMap((rule) => [`<rule source="${rule.path}">`, rule.content, '</rule>']),
      '</workspace_rules>',
    ].join('\n')
    return createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'plugin', plugin: name, form: 'instructions' },
    })
  }

  discoverRules(cwd) {
    const rules = new Map()
    for (const root of this.ruleRootsSync(cwd)) {
      for (const path of discoverMarkdownFilesSync(root.path, this.maxDepth)) {
        if (basename(path).toLowerCase() === 'readme.md') continue
        const rule = parseRuleSync(path)
        if (!rule) continue
        const key = relative(root.path, path).replaceAll('\\', '/')
        if (!rules.has(key)) rules.set(key, rule)
      }
    }
    return rules
  }

  ruleRootsSync(cwd) {
    const roots = []
    if (cwd) {
      const project = findProjectRootSync(resolve(cwd))
      roots.push(...projectRoots(project, RULES_DIR, 'project-dsh', PROJECT_DSH_RANK, 'project-agents', PROJECT_AGENTS_RANK))
    }
    roots.push(...userRoots(this.dshHome, this.agentsHome, RULES_DIR, 'user-dsh', USER_DSH_RANK, 'user-agents', USER_AGENTS_RANK))
    return roots
  }

  executeCommand(command, invocation) {
    const args = invocation.rawInput.trim()
    const prompt = [
      `Execute the workspace command /${command.name}.`,
      `Command definition: ${command.path}`,
      '',
      '<command_instructions>',
      command.content,
      '</command_instructions>',
      '',
      `Arguments: ${args || '(none)'}`,
      'Treat the command instructions as task-specific instructions. Read any referenced files before acting and perform the requested workflow.',
    ].join('\n')
    invocation.agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: name, form: 'instructions' },
    }))
    return { kind: 'success', text: `Started /${command.name}.` }
  }

  async skillRoots(cwd) {
    const roots = []
    if (cwd) {
      const project = await findProjectRoot(resolve(cwd))
      roots.push(...projectRoots(project, SKILLS_DIR, 'project-dsh', PROJECT_DSH_RANK, 'project-agents', PROJECT_AGENTS_RANK))
    }
    roots.push(...userRoots(this.dshHome, this.agentsHome, SKILLS_DIR, 'user-dsh', USER_DSH_RANK, 'user-agents', USER_AGENTS_RANK))
    return roots
  }

  commandRootsSync(cwd) {
    const roots = []
    if (cwd) {
      const project = findProjectRootSync(resolve(cwd))
      roots.push(...projectRoots(project, COMMANDS_DIR, 'project-dsh', PROJECT_DSH_RANK, 'project-agents', PROJECT_AGENTS_RANK))
    }
    roots.push(...userRoots(this.dshHome, this.agentsHome, COMMANDS_DIR, 'user-dsh', USER_DSH_RANK, 'user-agents', USER_AGENTS_RANK))
    return roots
  }

  dispose() {
    for (const dispose of this.commandDisposers.values()) dispose()
    this.commandDisposers.clear()
    for (const dispose of this.globalCommandDisposers.reverse()) dispose()
    this.globalCommandDisposers = []
  }
}

function projectRoots(projectRoot, leaf, dshSource, dshRank, agentsSource, agentsRank) {
  return [
    { path: join(projectRoot, '.dsh', leaf), source: dshSource, rank: dshRank },
    { path: join(projectRoot, '.agents', leaf), source: agentsSource, rank: agentsRank },
  ]
}

function userRoots(dshHome, agentsHome, leaf, dshSource, dshRank, agentsSource, agentsRank) {
  return [
    { path: join(dshHome, leaf), source: dshSource, rank: dshRank },
    { path: join(agentsHome, leaf), source: agentsSource, rank: agentsRank },
  ]
}

async function discoverMarkdownFiles(root, maxDepth) {
  const results = []
  await walk(root, 0, maxDepth, async (path, entry) => {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) results.push(path)
  })
  return results.sort((left, right) => left.localeCompare(right))
}

function discoverMarkdownFilesSync(root, maxDepth) {
  const results = []
  walkSync(root, 0, maxDepth, (path, entry) => {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) results.push(path)
  })
  return results.sort((left, right) => left.localeCompare(right))
}

function walkSync(root, depth, maxDepth, visit) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (absent(error)) return
    throw error
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    visit(path, entry)
    if (entry.isDirectory() && depth < maxDepth) walkSync(path, depth + 1, maxDepth, visit)
  }
}

async function discoverSkillFiles(root, maxDepth) {
  const results = []
  await walk(root, 0, maxDepth, async (path, entry) => {
    if (entry.isDirectory() && entry.name !== '.system') {
      const manifest = join(path, 'SKILL.md')
      if (await isFile(manifest)) results.push(manifest)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      results.push(path)
    }
  })
  return [...new Set(results)].sort((left, right) => left.localeCompare(right))
}

async function walk(root, depth, maxDepth, visit) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (absent(error)) return
    throw error
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    await visit(path, entry)
    if (entry.isDirectory() && depth < maxDepth) await walk(path, depth + 1, maxDepth, visit)
  }
}

async function parseCommand(path) {
  const raw = await readText(path)
  if (raw === undefined) return undefined
  const frontmatter = parseFrontmatter(raw)
  const title = raw.match(/^#\s+\/?([a-z][a-z0-9_-]*)\b[^\n]*/im)
  const commandName = stringValue(frontmatter?.data.name) ?? title?.[1] ?? basename(path, '.md')
  if (!/^[a-z][a-z0-9_-]*$/u.test(commandName)) {
    console.warn(`[${name}] command file ignored due to invalid name: ${path}`)
    return undefined
  }
  const firstHeading = raw.match(/^#\s+([^\n]+)/m)?.[1]?.replace(/^\/[a-z][a-z0-9_-]*\s*[—-]?\s*/u, '').trim()
  const description = stringValue(frontmatter?.data.description) ?? firstHeading ?? `Run ${commandName}`
  const content = frontmatter?.body.trim() || raw.trim()
  if (!content) return undefined
  return { name: commandName, description, content, path }
}

function parseCommandSync(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (absent(error)) return undefined
    throw error
  }
  const frontmatter = parseFrontmatter(raw)
  const title = raw.match(/^#\s+\/?([a-z][a-z0-9_-]*)\b[^\n]*/im)
  const commandName = stringValue(frontmatter?.data.name) ?? title?.[1] ?? basename(path, '.md')
  if (!/^[a-z][a-z0-9_-]*$/u.test(commandName)) return undefined
  const firstHeading = raw.match(/^#\s+([^\n]+)/m)?.[1]?.replace(/^\/[a-z][a-z0-9_-]*\s*[—-]?\s*/u, '').trim()
  const description = stringValue(frontmatter?.data.description) ?? firstHeading ?? `Run ${commandName}`
  const content = frontmatter?.body.trim() || raw.trim()
  return content ? { name: commandName, description, content, path } : undefined
}

function parseRuleSync(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (absent(error)) return undefined
    throw error
  }
  const frontmatter = parseFrontmatter(raw)
  const paths = stringArray(frontmatter?.data.paths)
  const content = frontmatter?.body.trim()
  // Path-scoped rules are intentionally opt-in: a Markdown file without paths is documentation.
  if (paths.length === 0 || !content) return undefined
  return { path, content, paths }
}

async function parseSkill(path) {
  const raw = await readText(path)
  if (raw === undefined) return undefined
  const frontmatter = parseFrontmatter(raw)
  if (!frontmatter) return undefined
  const skillName = stringValue(frontmatter.data.name)
  const description = stringValue(frontmatter.data.description)
  if (!skillName || !description || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skillName)) return undefined
  return {
    name: skillName,
    description,
    ...(stringValue(frontmatter.data.whenToUse) ? { whenToUse: frontmatter.data.whenToUse } : {}),
    invocation: {
      modelInvocable: frontmatter.data['disable-model-invocation'] !== true,
      userInvocable: frontmatter.data['user-invocable'] !== false,
    },
    metadata: typeof frontmatter.data.metadata === 'object' && frontmatter.data.metadata && !Array.isArray(frontmatter.data.metadata) ? frontmatter.data.metadata : undefined,
    content: frontmatter.body.trim(),
  }
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return undefined
  const end = raw.indexOf('\n---', 4)
  if (end < 0) return undefined
  const lines = raw.slice(4, end).split(/\r?\n/)
  const data = {}
  let listKey
  for (const line of lines) {
    const item = /^\s+-\s+(.+)$/.exec(line)
    if (item && listKey !== undefined) {
      const value = item[1].trim().replace(/^['"]|['"]$/g, '')
      data[listKey].push(value)
      continue
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) {
      listKey = undefined
      continue
    }
    const key = match[1]
    const rawValue = match[2].trim()
    if (rawValue.length === 0) {
      data[key] = []
      listKey = key
      continue
    }
    const value = rawValue.replace(/^['"]|['"]$/g, '')
    data[key] = value === 'true' ? true : value === 'false' ? false : value
    listKey = undefined
  }
  return { data, body: raw.slice(end + 4) }
}

async function findProjectRoot(cwd) {
  let current = cwd
  while (true) {
    if (await exists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

function findProjectRootSync(cwd) {
  let current = cwd
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (absent(error)) return false
    throw error
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (absent(error)) return false
    throw error
  }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (absent(error)) return undefined
    throw error
  }
}

function absent(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function filePathFromToolExecution(exec) {
  if (!['read', 'write', 'edit'].includes(exec.name)) return undefined
  const args = exec.arguments
  if (args === null || typeof args !== 'object' || typeof args.file_path !== 'string') return undefined
  return args.file_path.trim() || undefined
}

function pathsMentioned(message) {
  if (!Array.isArray(message.content)) return []
  const paths = []
  for (const block of message.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    for (const match of block.text.matchAll(/(?:^|\s)(?:@)?([A-Za-z]:[\\/][^\s`"']+|\.?(?:[\\/][^\s`"']+)+\.[A-Za-z0-9]+|(?:code|web|server)[\\/][^\s`"']+)/g)) paths.push(match[1])
  }
  return paths
}

function normalizeWorkspacePath(path, cwd) {
  const absolute = resolve(cwd, path)
  const relativePath = relative(cwd, absolute).replaceAll('\\', '/')
  return relativePath.startsWith('../') || relativePath === '..' ? path.replaceAll('\\', '/') : relativePath
}

function globMatches(pattern, path) {
  const normalized = pattern.replaceAll('\\', '/')
  let expression = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    const next = normalized[index + 1]
    if (char === '*' && next === '*') {
      if (normalized[index + 2] === '/') {
        expression += '(?:.*/)?'
        index += 2
      } else {
        expression += '.*'
        index += 1
      }
    } else if (char === '*') {
      expression += '[^/]*'
    } else if (char === '?') {
      expression += '[^/]'
    } else {
      expression += /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char
    }
  }
  return new RegExp(`^${expression}$`).test(path)
}

function stringArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
  const single = stringValue(value)
  return single === undefined ? [] : [single]
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function message(error) {
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
