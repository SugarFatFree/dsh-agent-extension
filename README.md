# dsh-agent-extension

[中文文档](README.zh-CN.md)

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin that discovers reusable Markdown slash commands, skills, and path-scoped rules from a project and the current user's configuration directories.

## Features

- Discovers project-level and user-level commands, skills, and rules.
- Supports both `.dsh` and `.agents` directory conventions.
- Resolves duplicate definitions predictably through documented precedence.
- Registers Markdown commands as DSH slash commands.
- Supplies skills through DSH's skills provider API.
- Injects matching path-scoped rules after relevant workspace file activity.
- Works with nested definitions up to six directories below each discovery root.

## Requirements

- DeepSeek Harness with a `web` profile.
- `pnpm`, which DSH uses for profile plugin management.

## Install

Install directly from GitHub with DSH's native plugin command:

```sh
dsh plugin --profile web add github:SugarFatFree/dsh-agent-extension
```

DSH recognizes this package as a plugin because its `package.json` declares `dsh.bundle.patch`. The command installs it into the selected profile and adds it to `dsh.profile.bundles` automatically.

Restart the DSH Web process and refresh the browser after installation. Create a new session or resume an existing one to refresh its slash-command catalog.

### Distribution status

This project is currently distributed from GitHub only; it is not published to npm. GitHub installation is fully supported and does not require an npm account:

```sh
dsh plugin --profile web add github:SugarFatFree/dsh-agent-extension
```

A future npm release may provide a shorter package-name install command, but npm publication is optional and does not affect DSH compatibility or catalog listing.

### Local development install

From this repository directory:

```sh
dsh plugin --profile web add .
```

After changing a local `file:` dependency, run `pnpm install --force` from the Web profile directory to refresh its installed `node_modules` copy, then restart DSH Web.

## Discovery roots

For a session, the project root is the nearest ancestor containing `.git`. If none exists, the session working directory is used.

| Type | Project roots | User roots |
| --- | --- | --- |
| Commands | `<project>/.dsh/commands/**`, `<project>/.agents/commands/**` | `~/.dsh/commands/**`, `~/.agents/commands/**` |
| Skills | `<project>/.dsh/skills/**`, `<project>/.agents/skills/**` | `~/.dsh/skills/**`, `~/.agents/skills/**` |
| Rules | `<project>/.dsh/rules/**`, `<project>/.agents/rules/**` | `~/.dsh/rules/**`, `~/.agents/rules/**` |

Definitions may be nested up to six levels. For example, `.agents/skills/team/review/SKILL.md` and `.dsh/commands/release/prepare.md` are discovered.

## Precedence

When definitions conflict, the first result wins in this order:

1. Project `.dsh`
2. Project `.agents`
3. User `~/.dsh`
4. User `~/.agents`

Commands use their command name as the conflict key. Skills use their skill name. Rules use their relative path below the relevant `rules` directory.

## Commands

Each Markdown file under a `commands` root becomes a slash command. Its name is resolved from YAML frontmatter `name`, then an H1 such as `# /release - Release`, then the filename.

```markdown
---
name: release
description: Prepare a release
---

Read the release checklist and prepare the release notes.
```

Entering `/release optional arguments` starts a normal agent turn with the command body and supplied arguments as task instructions.

Command roots are watched for Markdown additions, edits, deletions, and nested directory changes. After adding `.agents/commands/aa.md`, an already-open session receives `/aa` without restarting DSH Web; the command menu updates through DSH's live command-change event. Refresh the browser only if its connection was interrupted.

## Skills

A skill is either a Markdown file or a directory bundle containing `SKILL.md`. Skills require standard YAML frontmatter with a kebab-case `name` and `description`.

```markdown
---
name: api-review
description: Review API compatibility
whenToUse: Before publishing a changed API
---

Review the changed API surface.
```

The optional `disable-model-invocation`, `user-invocable`, and `metadata` frontmatter fields are passed through to DSH. Skills are exposed through DSH's Skills catalog and `/` skill source, not the command-only source; unreadable files in one discovery root are skipped so they do not hide skills from other roots.

## Path-scoped rules

A rule is a Markdown file under a `rules` root whose YAML frontmatter contains a non-empty `paths` list. Markdown files without `paths`, including `README.md`, are ignored.

```markdown
---
name: frontend-conventions
paths:
  - "code/frontend/**"
  - "web/**"
---

Use the established component and accessibility conventions.
```

A matching rule is injected once, immediately before the next model step after the agent successfully reads, writes, or edits a matching workspace file. Patterns are evaluated relative to the project root.

## Verify installation

Run the built-in command in an agent session:

```text
/dsh-extension-status
```

It reports the calling session's working directory plus discovered commands, skills, and rules. Discovered project commands are registered in the session command directory and appear in the `/` menu.

## License

[MIT](LICENSE)
