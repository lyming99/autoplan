# 发布说明

## 发布前检查

发布前请确认：

- 依赖已安装且项目能够在本地正常开发运行。

- \`package.json\` 中的 \`version\` 已更新为目标版本。

- Git 工作区干净，没有未提交或未跟踪文件。

- 当前仓库已配置可推送的远端，默认远端名为 \`origin\`。

- GitHub 仓库的 Actions 权限允许 workflow 读写 \`contents\`，以便内置 \`GITHUB\_TOKEN\` 创建或更新 Release。

- tag 使用 \`v\` 前缀，例如 \`v0.2.0\`。

### 运行时配置兼容检查

涉及计划后端配置的版本发布前，请在 Release notes 中明确以下兼容边界：

- 旧安装和旧 MCP/UI 调用默认保持 \`external-cli-markdown\` 计划生成 + \`external-cli\` 任务执行 + \`codex\` provider。

- 项目级旧字段 \`agentCliProvider\`、\`agentCliCommand\`、\`codexReasoningEffort\` 继续兼容，并在未填写新字段时映射为生成默认值和执行默认值。

- 单条需求/反馈的旧字段只兼容映射为计划生成覆盖；\`create\_requirement\`、\`create\_feedback\` 和 Composer 都不接受也不提交 \`planExecution\*\` 覆盖。

- 新文档和新示例应优先使用 \`planGeneration*\` 与 \`planExecution*\` 拆分字段，避免继续把生成 provider 和执行 provider 混在一起。

- \`builtin-llm-structured\` 计划生成依赖应用内 AI 配置、模型和 API key；没有可用配置时会走计划生成失败链路，不会写入 plan。

- \`builtin-llm\` 任务执行第一阶段未支持。配置可以保存，但执行任务时应明确报 \`builtin-llm execution is not supported yet\`，不能宣传为可用执行后端。

推荐在版本说明里给出新字段示例：

```json
{
  "planGenerationStrategy": "external-cli-structured",
  "planGenerationProvider": "claude",
  "planExecutionStrategy": "external-cli",
  "planExecutionProvider": "codex",
  "planExecutionCodexReasoningEffort": "medium"
}
```

单条需求/反馈示例只放生成覆盖：

```json
{
  "projectId": 1,
  "title": "反馈标题",
  "body": "反馈正文",
  "planGenerationStrategy": "builtin-llm-structured",
  "planGenerationProvider": "openai",
  "planGenerationModel": "model-from-ai-config"
}
```

AutoPlan 使用 GitHub Actions + electron-builder 发布桌面端安装包。当前发布流程覆盖 Windows、macOS、Linux 三个平台，支持推送 tag 自动触发，也支持在 GitHub Actions 页面手动触发。

## GitHub Actions 触发方式

Release workflow 位于 \`.github/workflows/release.yml\`，触发方式如下：

- 推送匹配 \`v\*\` 的 tag 时自动触发，例如 \`git push origin v0.2.0\`。

- 在 GitHub Actions 页面手动运行 \`Release\` workflow，并填写 \`tag\`。

- 手动触发时可填写 \`release\_notes\`；为空时 workflow 会读取 tag message 或使用兜底说明。

workflow 会在三个 runner 上分别构建：

平台 | Runner | 打包命令 | 主要产物
--- | --- | --- | ---
Windows | `windows-latest` | `npm run package:win` | NSIS 安装包
macOS | `macos-latest` | `npm run package:mac` | DMG、ZIP
Linux | `ubuntu-latest` | `npm run package:linux` | AppImage、DEB

每个平台的构建结果会先上传为 workflow artifact，随后发布 job 使用仓库内置 \`GITHUB\_TOKEN\` 创建或更新 GitHub Release，并把三端产物附加到 Release。

## 产物命名与位置

本地和 CI 打包输出目录均为 \`release/\`。产物命名包含产品名、版本、平台和架构，避免不同平台互相覆盖：

- Windows：\`AutoPlan-<version>-win-<arch>-Setup.<ext>\`

- macOS：\`AutoPlan-<version>-mac-<arch>.<ext>\`

- Linux：\`AutoPlan-<version>-linux-<arch>.<ext>\`

GitHub Release 页面会展示最终附件；Actions 页面中也可以查看各平台上传的临时 artifact。

## 本地发布脚本

自动 beta 发布脚本位于 \`scripts/release\_beta.py\`。它会读取当前 \`package.json\` 版本，生成下一个 \`X.Y.Z-beta.N\` 版本号，调用 Codex CLI 分析上一个 tag 之后的提交并生成 release notes，更新 \`package.json\` / \`package-lock.json\`，执行编译验证，然后提交、推送当前分支并调用底层 \`scripts/release.py\` 推送 tag。

常用示例：

```bash
python scripts/release_beta.py --dry-run
python scripts/release_beta.py --yes
python scripts/release_beta.py --next-version 0.2.1-beta.3 --yes
```

\`release\_beta.py\` 默认会使用 npm 10 同步 lockfile，以贴近 GitHub Actions 中的 \`npm ci\` 环境；默认编译命令是 \`npm run build\`。如果工作区只有 \`docs/plan\` 或 \`docs/progress/logs\` 下的生成文件，脚本会在发布期间临时 stash，发布结束后恢复；其它未提交变更会阻止自动发布，避免把业务代码或临时文件混入发布提交。

底层 tag 发布脚本位于 \`scripts/release.py\`。脚本只负责编排 tag 创建与推送，不在本地执行三端构建；三端构建由 GitHub Actions 完成。

常用示例：

```bash
python scripts/release.py --tag v0.2.0 --notes "发布说明"
python scripts/release.py --tag v0.2.0 --notes-file docs/release-notes/v0.2.0.md
python scripts/release.py --tag v0.2.1-beta.1 --notes-file docs/release-notes/v0.2.1-beta.1.md --yes
python scripts/release.py --tag v0.2.0 --notes "test release" --dry-run
python scripts/release.py --tag v0.2.0 --notes-file notes.md --yes
```

脚本会检查以下常见失败场景并给出提示：

- 未安装 Git，或当前目录不是 Git 仓库。

- 工作区不干净。

- 指定远端不存在，默认检查 \`origin\`。

- tag 格式不符合 Git ref 规范。

- 本地或远端已存在同名 tag。

- 推送远端失败。

- 未检测到 GitHub CLI 时会给出提示；基础 tag 推送不强制依赖 \`gh\`。

默认情况下，脚本会在真正创建并推送 tag 前要求交互确认。使用 \`--dry-run\` 只执行检查，不创建本地 tag，也不推送远端；使用 \`--yes\` 可跳过确认。

## Beta 发布流程

Beta 版本用于快速分发近期修复和功能更新，tag 必须使用可识别的预发布格式，例如 \`v0.2.1-beta.1\`，并确保 \`package.json\` 中的 \`version\` 与去掉 \`v\` 前缀后的版本号一致，例如 \`0.2.1-beta.1\`。推荐优先使用自动 beta 发布脚本：

```bash
python scripts/release_beta.py --yes
```

该脚本会自动在 \`docs/release-notes/\` 下生成与 tag 对齐的 Release notes，例如 \`docs/release-notes/v0.2.1-beta.3.md\`。Release notes 开头会明确标注 beta 是未完整人工测试的预发布版本，并包含近期更新摘要、风险提示、Issue 反馈入口，以及“AI 修复问题后编译通过即可发布”的策略说明。

如果需要手工发布某个已准备好的 beta notes，仍可使用底层脚本和 \`--notes-file\`，避免长 Markdown 文案在命令行中转义出错：

```bash
python scripts/release.py --tag v0.2.1-beta.1 --notes-file docs/release-notes/v0.2.1-beta.1.md --yes
```

脚本会把 Release notes 写入 annotated tag message。tag 推送后，GitHub Actions Release workflow 会优先使用该 tag message 生成 GitHub Release 正文。

## 版本说明传递

版本说明支持两种本地输入方式：

- \`--notes\`：直接传入短文本。

- \`--notes-file\`：从 UTF-8 文本文件读取，适合包含换行、中文、Markdown 列表或链接的长说明。

脚本会把版本说明写入 annotated tag message。tag 推送触发 workflow 后，发布 job 会按以下优先级生成 Release 正文：

1. 手动触发 workflow 时填写的 \`release\_notes\`。

1. tag 中的 annotated message。

1. 最近一次提交摘要。

1. 默认模板 \`Automated release for <tag>.\`。

如果同一 tag 的 Release 已存在，workflow 会更新 Release 标题和正文，并使用 \`--clobber\` 覆盖同名附件。

## 当前能力边界

当前发布流程不包含以下能力：

- 代码签名。

- macOS 公证。

- 自动更新服务器或增量更新分发。

- 私有证书、密钥或额外 token 的管理。

这些能力可在后续任务中补充；当前基础发布只依赖 GitHub Actions、electron-builder 和仓库内置 \`GITHUB\_TOKEN\`。
