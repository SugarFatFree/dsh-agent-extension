import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceDiscovery } from './index.js'

const silentLogger = { warn() {} }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-extension-'))
  await mkdir(join(root, '.git'))
  return root
}

async function markdown(path, content) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

function discovery(root) {
  return new WorkspaceDiscovery({ logger: silentLogger }, {
    dshHome: join(root, 'user-dsh'),
    agentsHome: join(root, 'user-agents'),
  })
}

test('discovers nested skills through depth six but not seven', async () => {
  const root = await fixture()
  const skill = (name) => `---\nname: ${name}\ndescription: ${name}\n---\n\nInstructions.\n`
  await markdown(join(root, '.agents/skills/a/b/c/d/e/f/at-six/SKILL.md'), skill('at-six'))
  await markdown(join(root, '.agents/skills/a/b/c/d/e/f/g/at-seven/SKILL.md'), skill('at-seven'))

  const skills = await discovery(root).list({ cwd: root })
  assert.deepEqual(skills.map((entry) => entry.name), ['at-six'])
})

test('project dsh skill shadows lower-priority definitions', async () => {
  const root = await fixture()
  const skill = (description) => `---\nname: api-review\ndescription: ${description}\n---\n\nInstructions.\n`
  await markdown(join(root, '.dsh/skills/api-review/SKILL.md'), skill('project dsh'))
  await markdown(join(root, '.agents/skills/api-review/SKILL.md'), skill('project agents'))
  await markdown(join(root, 'user-dsh/skills/api-review/SKILL.md'), skill('user dsh'))

  const skills = await discovery(root).list({ cwd: root })
  const candidates = skills.filter((entry) => entry.name === 'api-review')
  assert.deepEqual(candidates.map((entry) => entry.rank), [50, 100, 150])
  assert.equal(candidates[0].description, 'project dsh')
})

test('registers commands in the agent command scope', async () => {
  const root = await fixture()
  await markdown(join(root, '.agents/commands/release.md'), '# /release - Release\n\nPrepare a release.\n')
  const registered = []
  const agent = {
    id: 'agent-1',
    session: { header: { cwd: root } },
    ctx: {
      inject(dependencies, setup) {
        assert.deepEqual(dependencies, ['commands'])
        setup({ commands: { register(definition) { registered.push(definition) } } })
        return { dispose: async () => {} }
      },
    },
  }

  discovery(root).registerCommandsFor(agent)
  assert.deepEqual(registered.map((entry) => entry.name), ['release'])
})

test('selects matching rules once using project-relative paths', async () => {
  const root = await fixture()
  const rule = (name, paths) => `---\nname: ${name}\npaths:\n${paths.map((path) => `  - "${path}"`).join('\n')}\n---\n\n${name} body.\n`
  await markdown(join(root, '.agents/rules/code.md'), rule('code', ['code/**', 'web/**']))
  await markdown(join(root, '.agents/rules/frontend.md'), rule('frontend', ['code/frontend/**', 'web/**']))
  await markdown(join(root, '.agents/rules/README.md'), '# Rules\n')
  const instance = discovery(root)
  const agent = { session: { header: { cwd: join(root, 'nested/session') } } }
  const selected = instance.rulesForStep(agent, [{ content: [{ type: 'text', text: '@code/frontend/app.ts' }] }])

  assert.deepEqual(selected.map((entry) => entry.content), ['code body.', 'frontend body.'])
  assert.deepEqual(instance.rulesForStep(agent, []), [])
})
