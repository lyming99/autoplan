#!/usr/bin/env python3
"""Create and push a release tag for the GitHub Actions release workflow."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


TAG_PREFIX = "v"


class ReleaseError(RuntimeError):
    """A user-facing release preflight error."""


def run_git(args: list[str], *, capture: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", *args],
            check=False,
            capture_output=capture,
            text=True,
            encoding="utf-8",
        )
    except FileNotFoundError as exc:
        raise ReleaseError("未找到 Git，请先安装 Git 并确认 git 命令已加入 PATH。") from exc


def require_success(result: subprocess.CompletedProcess[str], message: str) -> None:
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        if detail:
            raise ReleaseError(f"{message}\n{detail}")
        raise ReleaseError(message)


def ensure_git_available() -> None:
    if shutil.which("git") is None:
        raise ReleaseError("未找到 Git，请先安装 Git 并确认 git 命令已加入 PATH。")


def ensure_gh_hint() -> None:
    if shutil.which("gh") is None:
        print(
            "提示：未检测到 GitHub CLI（gh）。tag 推送仍可触发 Actions；如需本地确认登录状态，请安装并运行 gh auth login。",
            file=sys.stderr,
        )


def validate_tag(tag: str) -> None:
    if not tag.startswith(TAG_PREFIX) or len(tag) == 1:
        raise ReleaseError("tag 必须以 v 开头，例如 v0.2.0。")
    if any(char.isspace() for char in tag):
        raise ReleaseError("tag 不能包含空白字符。")
    invalid_chars = set("~^:?*[\\")
    if any(char in invalid_chars for char in tag) or ".." in tag or tag.endswith("."):
        raise ReleaseError("tag 包含 Git 不支持的字符，请使用类似 v0.2.0 的格式。")
    result = run_git(["check-ref-format", f"refs/tags/{tag}"])
    require_success(result, "tag 格式不符合 Git ref 规范。")


def ensure_repository() -> None:
    result = run_git(["rev-parse", "--is-inside-work-tree"])
    require_success(result, "当前目录不是 Git 仓库，请在项目根目录运行。")
    if result.stdout.strip() != "true":
        raise ReleaseError("当前目录不是 Git 工作区，请在项目根目录运行。")


def ensure_clean_worktree() -> None:
    result = run_git(["status", "--porcelain"])
    require_success(result, "无法读取 Git 工作区状态。")
    if result.stdout.strip():
        raise ReleaseError("工作区存在未提交或未跟踪文件，请先提交、暂存或清理后再发布。")


def ensure_remote(remote: str) -> None:
    result = run_git(["remote", "get-url", remote])
    require_success(result, f"未找到远端 {remote}，请先配置 Git 远端。")


def ensure_tag_absent(tag: str, remote: str) -> None:
    local = run_git(["rev-parse", "--verify", f"refs/tags/{tag}"])
    if local.returncode == 0:
        raise ReleaseError(f"本地 tag 已存在：{tag}。")

    remote_result = run_git(["ls-remote", "--tags", remote, tag])
    require_success(remote_result, f"无法查询远端 tag，请检查 {remote} 权限或网络。")
    if remote_result.stdout.strip():
        raise ReleaseError(f"远端 tag 已存在：{tag}。")


def read_notes(args: argparse.Namespace) -> str:
    if args.notes and args.notes_file:
        raise ReleaseError("--notes 与 --notes-file 只能二选一。")
    if args.notes:
        return args.notes
    if args.notes_file:
        path = Path(args.notes_file)
        try:
            return path.read_text(encoding="utf-8").rstrip()
        except FileNotFoundError as exc:
            raise ReleaseError(f"版本说明文件不存在：{path}") from exc
        except OSError as exc:
            raise ReleaseError(f"无法读取版本说明文件：{path}\n{exc}") from exc
    return ""


def confirm_release(tag: str, remote: str) -> None:
    answer = input(f"确认创建并推送 tag {tag} 到 {remote} 以触发 GitHub Release？[y/N] ")
    if answer.strip().lower() not in {"y", "yes"}:
        raise ReleaseError("已取消发布。")


def create_and_push_tag(tag: str, notes: str, remote: str) -> None:
    tag_message = notes.rstrip() or f"Release {tag}"
    with tempfile.TemporaryDirectory() as temp_dir:
        notes_path = Path(temp_dir) / "release-notes.md"
        notes_path.write_text(f"{tag_message}\n", encoding="utf-8")
        tag_args = ["tag", "-a", tag, "-F", str(notes_path)]
        require_success(run_git(tag_args), f"创建本地 tag 失败：{tag}。")

    push_result = run_git(["push", remote, tag])
    if push_result.returncode != 0:
        run_git(["tag", "-d", tag])
        require_success(push_result, f"推送 tag 到 {remote} 失败，本地 tag 已尝试回滚。")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="创建并推送发布 tag，触发 GitHub Actions 三端 Release 工作流。"
    )
    parser.add_argument("--tag", required=True, help="发布 tag，例如 v0.2.0。")
    parser.add_argument("--notes", help="直接传入版本说明文本。")
    parser.add_argument("--notes-file", help="从 UTF-8 文本文件读取版本说明。")
    parser.add_argument("--remote", default="origin", help="要推送的 Git 远端，默认 origin。")
    parser.add_argument("--dry-run", action="store_true", help="只执行检查并展示动作，不创建或推送 tag。")
    parser.add_argument("--yes", action="store_true", help="跳过交互确认，直接创建并推送 tag。")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        notes = read_notes(args)
        ensure_git_available()
        validate_tag(args.tag)
        ensure_repository()
        ensure_clean_worktree()
        ensure_remote(args.remote)
        ensure_tag_absent(args.tag, args.remote)
        ensure_gh_hint()

        print(f"发布 tag：{args.tag}")
        print(f"目标远端：{args.remote}")
        print(f"版本说明：{'已提供' if notes else '未提供，将由 Release workflow 使用默认说明'}")

        if args.dry_run:
            print("dry-run：检查通过，不会创建本地 tag，也不会推送远端。")
            return 0

        if not args.yes:
            confirm_release(args.tag, args.remote)

        create_and_push_tag(args.tag, notes, args.remote)
        print(f"已推送 {args.tag}，GitHub Actions 将由 tag 推送触发 Release 工作流。")
        return 0
    except ReleaseError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
