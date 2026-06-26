# 发布说明

AutoPlan 使用 GitHub Actions + electron-builder 发布桌面端安装包。当前发布流程覆盖 Windows、macOS、Linux 三个平台，支持推送 tag 自动触发，也支持在 GitHub Actions 页面手动触发。

## 发布前检查

发布前请确认：

- 依赖已安装且项目能够在本地正常开发运行。
- `package.json` 中的 `version` 已更新为目标版本。
- Git 工作区干净，没有未提交或未跟踪文件。
- 当前仓库已配置可推送的远端，默认远端名为 `origin`。
- GitHub 仓库的 Actions 权限允许 workflow 读写 `contents`，以便内置 `GITHUB_TOKEN` 创建或更新 Release。
- tag 使用 `v` 前缀，例如 `v0.2.0`。

## GitHub Actions 触发方式

Release workflow 位于 `.github/workflows/release.yml`，触发方式如下：

- 推送匹配 `v*` 的 tag 时自动触发，例如 `git push origin v0.2.0`。
- 在 GitHub Actions 页面手动运行 `Release` workflow，并填写 `tag`。
- 手动触发时可填写 `release_notes`；为空时 workflow 会读取 tag message 或使用兜底说明。

workflow 会在三个 runner 上分别构建：

| 平台 | Runner | 打包命令 | 主要产物 |
| --- | --- | --- | --- |
| Windows | `windows-latest` | `npm run package:win` | NSIS 安装包 |
| macOS | `macos-latest` | `npm run package:mac` | DMG、ZIP |
| Linux | `ubuntu-latest` | `npm run package:linux` | AppImage、DEB |

每个平台的构建结果会先上传为 workflow artifact，随后发布 job 使用仓库内置 `GITHUB_TOKEN` 创建或更新 GitHub Release，并把三端产物附加到 Release。

## 产物命名与位置

本地和 CI 打包输出目录均为 `release/`。产物命名包含产品名、版本、平台和架构，避免不同平台互相覆盖：

- Windows：`AutoPlan-<version>-win-<arch>-Setup.<ext>`
- macOS：`AutoPlan-<version>-mac-<arch>.<ext>`
- Linux：`AutoPlan-<version>-linux-<arch>.<ext>`

GitHub Release 页面会展示最终附件；Actions 页面中也可以查看各平台上传的临时 artifact。

## 本地一键发布脚本

本地发布脚本位于 `scripts/release.py`。脚本只负责编排 tag 创建与推送，不在本地执行三端构建；三端构建由 GitHub Actions 完成。

常用示例：

```bash
python scripts/release.py --tag v0.2.0 --notes "发布说明"
python scripts/release.py --tag v0.2.0 --notes-file docs/release-notes/v0.2.0.md
python scripts/release.py --tag v0.2.0 --notes "test release" --dry-run
python scripts/release.py --tag v0.2.0 --notes-file notes.md --yes
```

脚本会检查以下常见失败场景并给出提示：

- 未安装 Git，或当前目录不是 Git 仓库。
- 工作区不干净。
- 指定远端不存在，默认检查 `origin`。
- tag 格式不符合 Git ref 规范。
- 本地或远端已存在同名 tag。
- 推送远端失败。
- 未检测到 GitHub CLI 时会给出提示；基础 tag 推送不强制依赖 `gh`。

默认情况下，脚本会在真正创建并推送 tag 前要求交互确认。使用 `--dry-run` 只执行检查，不创建本地 tag，也不推送远端；使用 `--yes` 可跳过确认。

## 版本说明传递

版本说明支持两种本地输入方式：

- `--notes`：直接传入短文本。
- `--notes-file`：从 UTF-8 文本文件读取，适合包含换行、中文、Markdown 列表或链接的长说明。

脚本会把版本说明写入 annotated tag message。tag 推送触发 workflow 后，发布 job 会按以下优先级生成 Release 正文：

1. 手动触发 workflow 时填写的 `release_notes`。
2. tag 中的 annotated message。
3. 最近一次提交摘要。
4. 默认模板 `Automated release for <tag>.`。

如果同一 tag 的 Release 已存在，workflow 会更新 Release 标题和正文，并使用 `--clobber` 覆盖同名附件。

## 当前能力边界

当前发布流程不包含以下能力：

- 代码签名。
- macOS 公证。
- 自动更新服务器或增量更新分发。
- 私有证书、密钥或额外 token 的管理。

这些能力可在后续任务中补充；当前基础发布只依赖 GitHub Actions、electron-builder 和仓库内置 `GITHUB_TOKEN`。
