# dsh-agent-extension

[English README](README.md)

一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，用于从项目目录和当前用户的配置目录中发现可复用的 Markdown 斜杠命令、技能与按路径生效的规则。

## 功能

- 发现项目级和用户级的命令、技能与规则。
- 同时兼容 `.dsh` 与 `.agents` 目录约定。
- 按明确的优先级处理重名定义。
- 将 Markdown 命令注册为 DSH 斜杠命令。
- 通过 DSH Skills Provider API 提供技能。
- 在相关工作区文件操作后注入匹配的路径规则。
- 在每个发现根目录下最多递归六层。

## 前置条件

- 已安装带 `web` Profile 的 DeepSeek Harness。
- 已安装 `pnpm`，DSH 使用它管理 Profile 插件。

## 安装

使用 DSH 原生插件命令直接从 GitHub 安装：

```sh
dsh plugin --profile web add github:SugarFatFree/dsh-agent-extension
```

该插件的 `package.json` 声明了 `dsh.bundle.patch`，DSH 会将其识别为插件，安装到指定 Profile 中，并自动加入 `dsh.profile.bundles`。

安装后请重启 DSH Web 进程并刷新浏览器页面。新建或恢复一个会话后，斜杠命令目录会重新建立。

### 本地开发安装

在本仓库目录中执行：

```sh
dsh plugin --profile web add .
```

修改本地链接的包后，请重新安装或刷新 Profile 依赖，然后重启 DSH Web。

## 发现目录

对于每个会话，项目根目录为最近的包含 `.git` 的父目录；不存在 `.git` 时，则使用会话工作目录。

| 类型 | 项目目录 | 用户目录 |
| --- | --- | --- |
| 命令 | `<project>/.dsh/commands/**`、`<project>/.agents/commands/**` | `~/.dsh/commands/**`、`~/.agents/commands/**` |
| 技能 | `<project>/.dsh/skills/**`、`<project>/.agents/skills/**` | `~/.dsh/skills/**`、`~/.agents/skills/**` |
| 规则 | `<project>/.dsh/rules/**`、`<project>/.agents/rules/**` | `~/.dsh/rules/**`、`~/.agents/rules/**` |

定义最多可位于上述根目录之下六层。例如，`.agents/skills/team/review/SKILL.md` 和 `.dsh/commands/release/prepare.md` 都会被发现。

## 优先级

同类定义发生冲突时，按以下顺序优先使用第一个结果：

1. 项目 `.dsh`
2. 项目 `.agents`
3. 用户 `~/.dsh`
4. 用户 `~/.agents`

命令以命令名作为冲突键，技能以技能名作为冲突键，规则以各自 `rules` 根目录下的相对路径作为冲突键。

## 命令

`commands` 目录下的每个 Markdown 文件都会成为一个斜杠命令。名称依次取自 YAML frontmatter 的 `name`、形如 `# /release - Release` 的一级标题、文件名。

```markdown
---
name: release
description: Prepare a release
---

Read the release checklist and prepare the release notes.
```

输入 `/release optional arguments` 后，DSH 会启动一个普通 Agent 回合，并将命令正文与参数作为任务指令传入。

## 技能

技能可以是单个 Markdown 文件，也可以是包含 `SKILL.md` 的目录包。技能必须使用标准 YAML frontmatter，并提供 kebab-case 格式的 `name` 与 `description`。

```markdown
---
name: api-review
description: Review API compatibility
whenToUse: Before publishing a changed API
---

Review the changed API surface.
```

可选 frontmatter 字段 `disable-model-invocation`、`user-invocable` 与 `metadata` 会透传给 DSH。

## 按路径生效的规则

规则是 `rules` 目录下的 Markdown 文件，且 YAML frontmatter 中必须包含非空的 `paths` 列表。没有 `paths` 的 Markdown 文件，包括 `README.md`，都会被忽略。

```markdown
---
name: frontend-conventions
paths:
  - "code/frontend/**"
  - "web/**"
---

Use the established component and accessibility conventions.
```

Agent 成功读取、写入或编辑匹配的工作区文件后，匹配规则会在下一次模型执行前注入一次。路径模式相对于项目根目录判断。

## 验证安装

在 Agent 会话中运行内置命令：

```text
/dsh-extension-status
```

该命令会输出调用该命令的会话工作目录、扫描的根目录及已发现的命令。已发现的项目命令会注册到会话命令目录并显示在 `/` 菜单中。

## 许可证

[MIT](LICENSE)
