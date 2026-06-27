#!/usr/bin/env python3
"""Prepare, commit, push, and tag the next AutoPlan beta release."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


BETA_VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$")
STABLE_VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
DEFAULT_GENERATED_DIRS = ("docs/plan", "docs/progress/logs")
DEFAULT_LOCK_COMMAND = (
    "npx --yes -p npm@10 npm install --package-lock-only "
    "--ignore-scripts --registry=https://registry.npmjs.org"
)
DEFAULT_BUILD_COMMAND = "npm run build"
BETA_NOTICE = (
    "> **Beta 未测试版本**：这是面向快速分发的预发布版本，未经过完整人工测试，"
    "不等同于稳定正式版，也不承诺零缺陷。"
)
BETA_RISK_TEXT = (
    "本 beta 版本用于更快分发近期修复和功能更新。当前策略是：AI 修复问题后，"
    "只要项目编译通过即可发布，以减少人工测试和等待时间。因此，下载测试或"
    "日常使用中仍可能遇到功能缺陷、平台差异或安装包问题。"
)
BETA_ISSUE_TEXT = (
    "如果你发现问题，请直接到 GitHub Issue 界面提交反馈，并尽量包含使用的"
    "操作系统、安装包类型、复现步骤、截图或日志。后续 AutoPlan/AI 流程会持续"
    "从 Issue 中发现问题，生成修复计划并继续处理。"
)


class ReleaseBetaError(RuntimeError):
    """A user-facing beta release automation error."""


@dataclass
class ChangeSummary:
    previous_tag: str | None
    commit_log: str
    diff_stat: str
    name_status: str


def info(message: str) -> None:
    print(f"[release-beta] {message}")


def format_command(args: list[str]) -> str:
    return " ".join(shlex.quote(str(arg)) for arg in args)


def split_command(command: str) -> list[str]:
    parts = shlex.split(command)
    if not parts:
        raise ReleaseBetaError("命令不能为空。")
    return parts


def run(
    args: list[str],
    *,
    cwd: Path,
    input_text: str | None = None,
    capture: bool = True,
    check: bool = True,
    timeout: int | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            input=input_text,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=capture,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise ReleaseBetaError(f"未找到命令：{args[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ReleaseBetaError(f"命令超时：{format_command(args)}") from exc

    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        if detail:
            raise ReleaseBetaError(f"命令失败：{format_command(args)}\n{detail}")
        raise ReleaseBetaError(f"命令失败：{format_command(args)}")
    return result


def ensure_tool(name: str) -> None:
    if shutil.which(name) is None:
        raise ReleaseBetaError(f"未找到 {name}，请先安装并加入 PATH。")


def resolve_repo_root() -> Path:
    ensure_tool("git")
    result = run(["git", "rev-parse", "--show-toplevel"], cwd=Path.cwd())
    return Path(result.stdout.strip()).resolve()


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ReleaseBetaError(f"找不到文件：{path}") from exc
    except json.JSONDecodeError as exc:
        raise ReleaseBetaError(f"JSON 格式错误：{path}\n{exc}") from exc


def write_json(path: Path, data: dict) -> None:
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def normalize_repo_path(path: str) -> str:
    return path.replace("\\", "/").strip("/")


def is_under_any(path: str, roots: list[str]) -> bool:
    normalized = normalize_repo_path(path)
    for root in roots:
        candidate = normalize_repo_path(root)
        if normalized == candidate or normalized.startswith(candidate + "/"):
            return True
    return False


def status_entries(repo: Path) -> list[str]:
    result = run(["git", "status", "--porcelain=v1"], cwd=repo)
    return [line for line in result.stdout.splitlines() if line.strip()]


def paths_from_status_line(line: str) -> list[str]:
    path = line[3:]
    if " -> " in path:
        return [item.strip() for item in path.split(" -> ", 1)]
    return [path.strip()]


def ensure_dirty_is_stashable(repo: Path, generated_dirs: list[str]) -> None:
    blocked: list[str] = []
    for line in status_entries(repo):
        paths = paths_from_status_line(line)
        if not all(is_under_any(path, generated_dirs) for path in paths):
            blocked.append(line)
    if blocked:
        detail = "\n".join(blocked[:20])
        raise ReleaseBetaError(
            "工作区存在不属于生成目录的未提交变更，自动 beta 发布已停止。\n"
            "请先提交、暂存或清理这些变更：\n"
            f"{detail}"
        )


def stash_generated_changes(
    repo: Path,
    generated_dirs: list[str],
    *,
    no_stash_generated: bool,
) -> str | None:
    entries = status_entries(repo)
    if not entries:
        return None

    ensure_dirty_is_stashable(repo, generated_dirs)
    if no_stash_generated:
        raise ReleaseBetaError(
            "工作区包含生成目录变更，且已指定 --no-stash-generated，发布停止。"
        )

    message = f"release-beta generated files {datetime.now():%Y%m%d-%H%M%S}"
    info("暂存生成目录中的未跟踪/未提交文件，发布结束后会恢复。")
    run(
        [
            "git",
            "stash",
            "push",
            "--include-untracked",
            "-m",
            message,
            "--",
            *generated_dirs,
        ],
        cwd=repo,
        capture=True,
    )
    top = run(["git", "stash", "list", "--format=%gd%x00%s", "-n", "1"], cwd=repo)
    if message not in top.stdout:
        raise ReleaseBetaError("生成目录暂存失败，未找到刚创建的 stash。")
    return "stash@{0}"


def restore_stash(repo: Path, stash_ref: str | None) -> None:
    if not stash_ref:
        return
    info("恢复发布前暂存的生成目录文件。")
    run(["git", "stash", "pop", stash_ref], cwd=repo, capture=False)


def read_package_version(repo: Path) -> str:
    package = read_json(repo / "package.json")
    version = package.get("version")
    if not isinstance(version, str) or not version:
        raise ReleaseBetaError("package.json 缺少有效的 version 字段。")
    return version


def next_beta_version(current_version: str) -> str:
    beta_match = BETA_VERSION_RE.match(current_version)
    if beta_match:
        major, minor, patch, beta_number = beta_match.groups()
        return f"{major}.{minor}.{patch}-beta.{int(beta_number) + 1}"

    stable_match = STABLE_VERSION_RE.match(current_version)
    if stable_match:
        major, minor, patch = stable_match.groups()
        return f"{major}.{minor}.{int(patch) + 1}-beta.1"

    raise ReleaseBetaError(
        "无法从当前版本自动生成 beta 版本号："
        f"{current_version}。支持 X.Y.Z 或 X.Y.Z-beta.N。"
    )


def increment_beta_version(version: str) -> str:
    match = BETA_VERSION_RE.match(version)
    if not match:
        raise ReleaseBetaError(f"不是 beta 版本号：{version}")
    major, minor, patch, beta_number = match.groups()
    return f"{major}.{minor}.{patch}-beta.{int(beta_number) + 1}"


def validate_beta_version(version: str) -> None:
    if not BETA_VERSION_RE.match(version):
        raise ReleaseBetaError(
            f"目标版本必须是 X.Y.Z-beta.N 格式，当前为：{version}"
        )


def local_tag_exists(repo: Path, tag: str) -> bool:
    result = run(
        ["git", "rev-parse", "--verify", f"refs/tags/{tag}"],
        cwd=repo,
        check=False,
    )
    return result.returncode == 0


def remote_tag_exists(repo: Path, remote: str, tag: str) -> bool:
    result = run(
        ["git", "ls-remote", "--tags", "--refs", remote, tag],
        cwd=repo,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise ReleaseBetaError(f"无法查询远端 tag：{remote} {tag}\n{detail}")
    return bool(result.stdout.strip())


def choose_next_available_version(
    repo: Path,
    remote: str,
    requested_version: str,
    *,
    explicit: bool,
) -> str:
    validate_beta_version(requested_version)
    version = requested_version
    while local_tag_exists(repo, f"v{version}") or remote_tag_exists(
        repo, remote, f"v{version}"
    ):
        if explicit:
            raise ReleaseBetaError(f"目标 tag 已存在：v{version}")
        version = increment_beta_version(version)
    return version


def current_branch(repo: Path) -> str:
    branch = run(["git", "branch", "--show-current"], cwd=repo).stdout.strip()
    if not branch:
        raise ReleaseBetaError("当前处于 detached HEAD，无法自动推送分支。")
    return branch


def ensure_remote(repo: Path, remote: str) -> str:
    result = run(["git", "remote", "get-url", remote], cwd=repo, check=False)
    if result.returncode != 0:
        raise ReleaseBetaError(f"未找到 Git 远端：{remote}")
    return result.stdout.strip()


def find_previous_tag(repo: Path, current_version: str, override: str | None) -> str | None:
    if override:
        if not local_tag_exists(repo, override):
            raise ReleaseBetaError(f"指定的 previous tag 不存在于本地：{override}")
        return override

    current_tag = f"v{current_version}"
    if local_tag_exists(repo, current_tag):
        return current_tag

    result = run(
        ["git", "describe", "--tags", "--match", "v*", "--abbrev=0", "HEAD"],
        cwd=repo,
        check=False,
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    return None


def collect_change_summary(repo: Path, previous_tag: str | None) -> ChangeSummary:
    if previous_tag:
        range_spec = f"{previous_tag}..HEAD"
        commit_log = run(
            ["git", "log", "--oneline", "--decorate=no", range_spec],
            cwd=repo,
        ).stdout.strip()
        diff_stat = run(["git", "diff", "--stat", range_spec], cwd=repo).stdout.strip()
        name_status = run(
            ["git", "diff", "--name-status", range_spec],
            cwd=repo,
        ).stdout.strip()
    else:
        commit_log = run(
            ["git", "log", "--oneline", "--decorate=no", "-n", "40"],
            cwd=repo,
        ).stdout.strip()
        diff_stat = ""
        name_status = ""

    return ChangeSummary(
        previous_tag=previous_tag,
        commit_log=commit_log or "没有检测到上一个 tag 之后的新提交。",
        diff_stat=diff_stat or "没有可展示的 diff stat。",
        name_status=name_status or "没有可展示的文件变更列表。",
    )


def build_codex_prompt(
    *,
    tag: str,
    current_version: str,
    next_version: str,
    branch: str,
    summary: ChangeSummary,
) -> str:
    previous = summary.previous_tag or "无"
    return f"""请根据下面的 Git 信息，为 AutoPlan {tag} 生成中文 GitHub Release Markdown。

要求：
- 只输出 Markdown，不要使用代码围栏，不要解释你的写作过程。
- 标题必须是：# AutoPlan {tag}
- 必须明确包含 beta 说明：Beta 版本是未完整人工测试的预发布版本；AI 解决问题后，只要编译通过就发布，以减少测试时间。
- 必须说明：下载测试或使用中发现问题，可以直接到 GitHub Issue 界面提交；后续 AutoPlan/AI 流程会到 Issue 中找问题并继续解决。
- 只依据下面的提交、diff stat 和文件列表总结近期更新，不要编造不存在的功能。
- 建议结构：Beta 未测试版本提示、近期更新摘要、Beta 风险提示、问题反馈。

版本信息：
- 当前 package.json 版本：{current_version}
- 目标 beta 版本：{next_version}
- 目标 tag：{tag}
- 当前分支：{branch}
- 对比起点：{previous}

提交摘要：
{summary.commit_log}

Diff stat：
{summary.diff_stat}

文件变更：
{summary.name_status}
"""


def strip_markdown_fence(notes: str) -> str:
    stripped = notes.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


def ensure_release_note_sections(notes: str, tag: str) -> str:
    notes = strip_markdown_fence(notes)
    if not notes.startswith("# "):
        notes = f"# AutoPlan {tag}\n\n{notes}"

    lines = notes.splitlines()
    if lines and lines[0].strip() != f"# AutoPlan {tag}":
        lines[0] = f"# AutoPlan {tag}"
    notes = "\n".join(lines).strip()

    if "Beta 未测试版本" not in notes:
        notes = notes.replace(
            f"# AutoPlan {tag}",
            f"# AutoPlan {tag}\n\n{BETA_NOTICE}",
            1,
        )

    if "## Beta 风险提示" not in notes:
        notes = f"{notes}\n\n## Beta 风险提示\n\n{BETA_RISK_TEXT}"

    if "## 问题反馈" not in notes and "Issue" not in notes:
        notes = f"{notes}\n\n## 问题反馈\n\n{BETA_ISSUE_TEXT}"
    elif "Issue" not in notes:
        notes = f"{notes}\n\n{BETA_ISSUE_TEXT}"

    if "编译通过" not in notes:
        notes = f"{notes}\n\n{BETA_RISK_TEXT}"

    return notes.rstrip() + "\n"


def generate_fallback_notes(tag: str, summary: ChangeSummary) -> str:
    return ensure_release_note_sections(
        f"""# AutoPlan {tag}

{BETA_NOTICE}

## 近期更新摘要

{summary.commit_log}

## Beta 风险提示

{BETA_RISK_TEXT}

## 问题反馈

{BETA_ISSUE_TEXT}
""",
        tag,
    )


def generate_notes_with_codex(
    repo: Path,
    args: argparse.Namespace,
    prompt: str,
    tag: str,
    summary: ChangeSummary,
) -> str:
    if args.notes_file:
        notes_path = Path(args.notes_file)
        if not notes_path.is_absolute():
            notes_path = repo / notes_path
        return ensure_release_note_sections(notes_path.read_text(encoding="utf-8"), tag)

    if args.skip_codex:
        return generate_fallback_notes(tag, summary)

    ensure_tool(args.codex_command)
    with tempfile.TemporaryDirectory() as temp_dir:
        output_path = Path(temp_dir) / "release-notes.md"
        command = [
            args.codex_command,
            "exec",
            "--ephemeral",
            "--color",
            "never",
            "-C",
            str(repo),
            "--sandbox",
            "read-only",
            "--output-last-message",
            str(output_path),
        ]
        if args.codex_model:
            command.extend(["--model", args.codex_model])
        command.append("-")
        info("调用 Codex CLI 分析近期更新并生成 release notes。")
        run(
            command,
            cwd=repo,
            input_text=prompt,
            capture=True,
            timeout=args.codex_timeout,
        )
        if not output_path.exists():
            raise ReleaseBetaError("Codex 未生成 release notes 输出文件。")
        return ensure_release_note_sections(output_path.read_text(encoding="utf-8"), tag)


def update_package_files(repo: Path, next_version: str) -> None:
    package_path = repo / "package.json"
    package = read_json(package_path)
    package["version"] = next_version
    write_json(package_path, package)

    lock_path = repo / "package-lock.json"
    if lock_path.exists():
        lock = read_json(lock_path)
        root_package = lock.get("packages", {}).get("")
        if isinstance(root_package, dict):
            root_package["version"] = next_version
        write_json(lock_path, lock)


def write_release_notes(repo: Path, tag: str, notes: str) -> Path:
    notes_dir = repo / "docs" / "release-notes"
    notes_dir.mkdir(parents=True, exist_ok=True)
    notes_path = notes_dir / f"{tag}.md"
    notes_path.write_text(notes, encoding="utf-8")
    return notes_path


def relative_to_repo(repo: Path, path: Path) -> str:
    return path.resolve().relative_to(repo).as_posix()


def run_lock_sync(repo: Path, args: argparse.Namespace) -> None:
    if args.skip_lock_sync:
        info("跳过 package-lock 同步。")
        return
    info("使用 npm 10 同步 package-lock.json。")
    run(split_command(args.lock_command), cwd=repo, capture=False)


def run_build(repo: Path, args: argparse.Namespace) -> None:
    if args.skip_build:
        info("跳过构建验证。")
        return
    info("运行构建验证，编译通过后才继续发布。")
    run(split_command(args.build_command), cwd=repo, capture=False)


def stage_and_commit(repo: Path, tag: str, notes_path: Path, message: str | None) -> None:
    paths = ["package.json", "package-lock.json", relative_to_repo(repo, notes_path)]
    run(["git", "add", "--", *paths], cwd=repo)
    diff = run(["git", "diff", "--cached", "--quiet"], cwd=repo, check=False)
    if diff.returncode == 0:
        raise ReleaseBetaError("没有可提交的发布变更。")

    commit_message = message or f"Prepare {tag} beta release"
    info(f"提交发布版本变更：{commit_message}")
    run(["git", "commit", "-m", commit_message], cwd=repo, capture=False)


def push_branch(repo: Path, remote: str, branch: str) -> None:
    info(f"推送分支 {branch} 到 {remote}。")
    run(["git", "push", remote, branch], cwd=repo, capture=False)


def run_release_tag(repo: Path, remote: str, tag: str, notes_path: Path) -> None:
    info(f"调用 scripts/release.py 推送 tag {tag}。")
    run(
        [
            sys.executable,
            str(repo / "scripts" / "release.py"),
            "--tag",
            tag,
            "--notes-file",
            relative_to_repo(repo, notes_path),
            "--remote",
            remote,
            "--yes",
        ],
        cwd=repo,
        capture=False,
    )


def github_release_url(remote_url: str, tag: str) -> str | None:
    match = re.search(r"github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/]+)$", remote_url)
    if not match:
        return None
    repo_name = match.group("repo")
    if repo_name.endswith(".git"):
        repo_name = repo_name[:-4]
    return (
        f"https://github.com/{match.group('owner')}/{repo_name}"
        f"/releases/tag/{tag}"
    )


def confirm(args: argparse.Namespace, *, tag: str, next_version: str, branch: str) -> None:
    if args.yes:
        return
    print()
    print("即将执行 beta 自动发布：")
    print(f"- 版本：{next_version}")
    print(f"- tag：{tag}")
    print(f"- 分支：{branch}")
    print("- 动作：生成说明、更新版本、同步 lockfile、构建、提交、推送分支、推送 tag")
    answer = input("确认继续？[y/N] ")
    if answer.strip().lower() not in {"y", "yes"}:
        raise ReleaseBetaError("已取消 beta 发布。")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "自动生成下一个 beta 版本号，调用 Codex 分析近期更新，"
            "更新版本与 release notes，编译通过后提交并推送 GitHub release tag。"
        )
    )
    parser.add_argument("--remote", default="origin", help="Git 远端名，默认 origin。")
    parser.add_argument("--branch", help="要求当前分支名匹配该值；默认使用当前分支。")
    parser.add_argument("--next-version", help="手动指定目标 beta 版本，例如 0.2.1-beta.3。")
    parser.add_argument("--previous-tag", help="手动指定 release notes 对比起点 tag。")
    parser.add_argument("--notes-file", help="使用已有 release notes 文件，不调用 Codex。")
    parser.add_argument("--codex-command", default="codex", help="Codex CLI 命令名或路径。")
    parser.add_argument("--codex-model", help="传给 codex exec 的模型名。")
    parser.add_argument("--codex-timeout", type=int, default=900, help="Codex 生成超时秒数。")
    parser.add_argument(
        "--skip-codex",
        action="store_true",
        help="跳过 Codex 分析，使用模板生成说明；建议仅 dry-run/debug 使用。",
    )
    parser.add_argument("--lock-command", default=DEFAULT_LOCK_COMMAND, help="同步 lockfile 命令。")
    parser.add_argument("--build-command", default=DEFAULT_BUILD_COMMAND, help="编译验证命令。")
    parser.add_argument("--skip-lock-sync", action="store_true", help="跳过 package-lock 同步。")
    parser.add_argument("--skip-build", action="store_true", help="跳过构建验证。")
    parser.add_argument(
        "--generated-dirty-path",
        action="append",
        help="允许自动 stash 的生成目录，可重复传入。",
    )
    parser.add_argument(
        "--no-stash-generated",
        action="store_true",
        help="如果生成目录存在脏文件则直接失败，不自动 stash。",
    )
    parser.add_argument("--commit-message", help="自定义发布提交信息。")
    parser.add_argument("--dry-run", action="store_true", help="只展示计划，不写文件、不提交、不推送。")
    parser.add_argument("--yes", action="store_true", help="跳过交互确认。")
    parser.add_argument("--skip-fetch", action="store_true", help="跳过发布前 git fetch --tags。")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    repo = Path.cwd()
    stash_ref: str | None = None
    restore_error: ReleaseBetaError | None = None
    return_code = 0

    try:
        repo = resolve_repo_root()
        os.chdir(repo)
        generated_dirs = args.generated_dirty_path or list(DEFAULT_GENERATED_DIRS)
        ensure_tool("git")
        ensure_remote(repo, args.remote)
        branch = current_branch(repo)
        if args.branch and args.branch != branch:
            raise ReleaseBetaError(f"当前分支是 {branch}，不是指定分支 {args.branch}。")

        ensure_dirty_is_stashable(repo, generated_dirs)

        if not args.skip_fetch and not args.dry_run:
            info(f"拉取 {args.remote} 的 tags，避免重复发布。")
            run(["git", "fetch", "--tags", args.remote], cwd=repo, capture=False)

        current_version = read_package_version(repo)
        requested_version = args.next_version or next_beta_version(current_version)
        next_version = choose_next_available_version(
            repo,
            args.remote,
            requested_version,
            explicit=bool(args.next_version),
        )
        tag = f"v{next_version}"
        previous_tag = find_previous_tag(repo, current_version, args.previous_tag)
        summary = collect_change_summary(repo, previous_tag)
        prompt = build_codex_prompt(
            tag=tag,
            current_version=current_version,
            next_version=next_version,
            branch=branch,
            summary=summary,
        )
        notes = generate_notes_with_codex(repo, args, prompt, tag, summary)

        info(f"当前版本：{current_version}")
        info(f"目标版本：{next_version}")
        info(f"目标 tag：{tag}")
        info(f"对比起点：{previous_tag or '无'}")

        if args.dry_run:
            print()
            print("dry-run：不会写文件、不会提交、不会推送。Release notes 预览：")
            print("-" * 72)
            print(notes.rstrip())
            print("-" * 72)
        else:
            confirm(args, tag=tag, next_version=next_version, branch=branch)
            stash_ref = stash_generated_changes(
                repo,
                generated_dirs,
                no_stash_generated=args.no_stash_generated,
            )
            update_package_files(repo, next_version)
            notes_path = write_release_notes(repo, tag, notes)
            run_lock_sync(repo, args)
            run_build(repo, args)
            stage_and_commit(repo, tag, notes_path, args.commit_message)
            push_branch(repo, args.remote, branch)
            run_release_tag(repo, args.remote, tag, notes_path)

            release_url = github_release_url(ensure_remote(repo, args.remote), tag)
            info("beta 发布流程完成。")
            if release_url:
                info(f"GitHub Release：{release_url}")
    except ReleaseBetaError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return_code = 1
    finally:
        if stash_ref:
            try:
                restore_stash(repo, stash_ref)
            except ReleaseBetaError as exc:
                restore_error = exc

    if restore_error:
        print(f"错误：恢复生成目录 stash 失败：{restore_error}", file=sys.stderr)
        return 1
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
