#!/usr/bin/env python3
"""The book's grader: list chapters, start one, grade it tier by tier.

Stdlib only; requires Python 3.11+ (tomllib).

Usage:
  python3 books/dsa/tools/runner.py list
  python3 books/dsa/tools/runner.py start ch01 [--force]
  python3 books/dsa/tools/runner.py run ch01 [--tier public|edge|stress|perf]
  python3 books/dsa/tools/runner.py verify ch01
  python3 books/dsa/tools/runner.py status
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

if sys.version_info < (3, 11):  # tomllib arrived in 3.11
    sys.exit(f"The book's tools need Python 3.11+; this is Python {sys.version.split()[0]}.")

import tomllib

BOOK_DIR = Path(__file__).resolve().parent.parent
CHAPTERS_DIR = BOOK_DIR / "chapters"
WORKSPACE_DIR = BOOK_DIR / "workspace"
PROGRESS_PATH = BOOK_DIR / ".progress.json"

TIER_ORDER = ["public", "edge", "stress", "perf"]
DEFAULT_XP = {"public": 10, "edge": 15, "stress": 20, "perf": 25}
DEFAULT_TIMEOUT = {"public": 30, "edge": 30, "stress": 120, "perf": 60}

BADGES = {
    "first-green": "First fully green chapter",
    "stress-buster": "First stress tier passed",
    "big-input-slayer": "First perf tier passed",
}

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
BOLD = "\033[1m"
RESET = "\033[0m"


@dataclass
class Tier:
    name: str
    xp: int
    timeout: int
    test_file: Path


@dataclass
class Chapter:
    id: str
    slug: str
    title: str
    module: str
    path: Path
    tiers: list[Tier] = field(default_factory=list)

    @property
    def workspace(self) -> Path:
        return WORKSPACE_DIR / self.id


def discover_chapters() -> list[Chapter]:
    chapters = []
    if not CHAPTERS_DIR.is_dir():
        return chapters
    for path in sorted(CHAPTERS_DIR.iterdir()):
        manifest = path / "exercise.toml"
        if not manifest.is_file():
            continue
        chapters.append(load_chapter(path))
    return chapters


def load_chapter(path: Path) -> Chapter:
    with open(path / "exercise.toml", "rb") as fh:
        meta = tomllib.load(fh)
    chapter = Chapter(
        id=meta["id"],
        slug=path.name,
        title=meta["title"],
        module=meta["module"],
        path=path,
    )
    declared = meta.get("tiers", {})
    for name in TIER_ORDER:
        test_file = path / "tests" / f"test_{name}.py"
        if not test_file.is_file():
            continue
        tier_meta = declared.get(name, {})
        chapter.tiers.append(
            Tier(
                name=name,
                xp=int(tier_meta.get("xp", DEFAULT_XP[name])),
                timeout=int(tier_meta.get("timeout", DEFAULT_TIMEOUT[name])),
                test_file=test_file,
            )
        )
    return chapter


def find_chapter(chapter_id: str) -> Chapter:
    for chapter in discover_chapters():
        if chapter.id == chapter_id or chapter.slug == chapter_id:
            return chapter
    sys.exit(f"{RED}No chapter named {chapter_id!r}. Try `runner.py list`.{RESET}")


# ---------------------------------------------------------------- progress --

def load_progress() -> dict:
    if PROGRESS_PATH.is_file():
        with open(PROGRESS_PATH) as fh:
            return json.load(fh)
    return {"chapters": {}, "xp": 0, "badges": [], "streak": {"days": 0, "last": None}}


def save_progress(progress: dict) -> None:
    with open(PROGRESS_PATH, "w") as fh:
        json.dump(progress, fh, indent=2)
        fh.write("\n")


def record_pass(progress: dict, chapter: Chapter, tier: Tier, today: date | None = None) -> list[str]:
    """Record a first-time tier pass. Returns newly earned badges."""
    today = today or date.today()
    chapter_state = progress["chapters"].setdefault(chapter.id, {})
    if chapter_state.get(tier.name, {}).get("passed"):
        return []
    chapter_state[tier.name] = {
        "passed": True,
        "first_passed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    progress["xp"] += tier.xp

    streak = progress["streak"]
    if streak["last"] != today.isoformat():
        previous = streak["last"]
        yesterday = date.fromordinal(today.toordinal() - 1).isoformat()
        streak["days"] = streak["days"] + 1 if previous == yesterday else 1
        streak["last"] = today.isoformat()

    earned = []
    if tier.name == "stress" and "stress-buster" not in progress["badges"]:
        earned.append("stress-buster")
    if tier.name == "perf" and "big-input-slayer" not in progress["badges"]:
        earned.append("big-input-slayer")
    all_green = all(
        chapter_state.get(t.name, {}).get("passed") for t in chapter.tiers
    )
    if all_green and "first-green" not in progress["badges"]:
        earned.append("first-green")
    progress["badges"].extend(earned)
    return earned


# ------------------------------------------------------------------ grading --

def run_tier(chapter: Chapter, tier: Tier, solution_dir: Path) -> tuple[str, str]:
    """Run one tier. Returns (outcome, output) where outcome is
    'pass' | 'fail' | 'timeout'."""
    env = dict(os.environ)
    env["BOOK_SOLUTION_DIR"] = str(solution_dir)
    env["PYTHONPATH"] = os.pathsep.join(
        p for p in [str(BOOK_DIR / "tools"), env.get("PYTHONPATH")] if p
    )
    try:
        proc = subprocess.run(
            [sys.executable, str(tier.test_file)],
            env=env,
            capture_output=True,
            text=True,
            timeout=tier.timeout,
        )
    except subprocess.TimeoutExpired:
        return "timeout", f"exceeded the {tier.timeout}s time limit"
    output = (proc.stdout + proc.stderr).strip()
    return ("pass" if proc.returncode == 0 else "fail"), output


def grade(chapter: Chapter, solution_dir: Path, only_tier: str | None,
          progress: dict | None) -> bool:
    print(f"{BOLD}{chapter.id} — {chapter.title}{RESET}")
    print(f"grading code in: {solution_dir}\n")
    all_passed = True
    for tier in chapter.tiers:
        if only_tier and tier.name != only_tier:
            continue
        outcome, output = run_tier(chapter, tier, solution_dir)
        if outcome == "pass":
            print(f"  {GREEN}✔ {tier.name:<7}{RESET} passed  (+{tier.xp} XP)")
            if progress is not None:
                for badge in record_pass(progress, chapter, tier):
                    print(f"    {YELLOW}★ badge earned: {badge} — {BADGES[badge]}{RESET}")
        elif outcome == "timeout":
            print(f"  {RED}✘ {tier.name:<7} TIME LIMIT EXCEEDED{RESET} — {output}")
            print(f"    A correct-but-slow solution fails here on purpose. "
                  f"Re-read the complexity section of the chapter.")
            all_passed = False
        else:
            print(f"  {RED}✘ {tier.name:<7} failed{RESET}")
            tail = "\n".join(output.splitlines()[-15:])
            print("    " + tail.replace("\n", "\n    "))
            all_passed = False
        if not all_passed:
            break  # tiers gate each other: fix this one before the next runs
    if progress is not None:
        save_progress(progress)
    return all_passed


# ----------------------------------------------------------------- commands --

def cmd_list(_args) -> int:
    progress = load_progress()
    chapters = discover_chapters()
    if not chapters:
        print("No chapters found.")
        return 1
    print(f"{BOLD}Chapters{RESET}")
    for chapter in chapters:
        state = progress["chapters"].get(chapter.id, {})
        marks = "".join(
            f"{GREEN}●{RESET}" if state.get(t.name, {}).get("passed") else "○"
            for t in chapter.tiers
        )
        started = "" if chapter.workspace.is_dir() else "  (not started)"
        print(f"  {chapter.id}  {marks}  {chapter.title}{started}")
    print(f"\ntiers per chapter: {' → '.join(t.name for t in chapters[0].tiers)}")
    return 0


def cmd_start(args) -> int:
    chapter = find_chapter(args.chapter)
    if chapter.workspace.is_dir() and not args.force:
        print(f"{chapter.workspace} already exists; use --force to reset it.")
        return 1
    if chapter.workspace.is_dir():
        shutil.rmtree(chapter.workspace)
    shutil.copytree(chapter.path / "starter", chapter.workspace)
    print(f"{GREEN}Started {chapter.id}.{RESET}")
    print(f"  read:  {chapter.path / 'chapter.md'}")
    print(f"  edit:  {chapter.workspace / (chapter.module + '.py')}")
    print(f"  grade: python3 books/dsa/tools/runner.py run {chapter.id}")
    return 0


def cmd_run(args) -> int:
    chapter = find_chapter(args.chapter)
    if not chapter.workspace.is_dir():
        print(f"Chapter not started. Run: python3 books/dsa/tools/runner.py start {chapter.id}")
        return 1
    progress = load_progress()
    ok = grade(chapter, chapter.workspace, args.tier, progress)
    if ok:
        print(f"\n{GREEN}{BOLD}Chapter green.{RESET} XP total: {progress['xp']}")
    return 0 if ok else 1


def cmd_verify(args) -> int:
    chapter = find_chapter(args.chapter)
    ok = grade(chapter, chapter.path / "solution", args.tier, progress=None)
    print(f"\nreference solution: {'OK' if ok else 'FAILING'}")
    return 0 if ok else 1


def cmd_status(_args) -> int:
    progress = load_progress()
    print(f"{BOLD}XP:{RESET} {progress['xp']}")
    print(f"{BOLD}streak:{RESET} {progress['streak']['days']} day(s)")
    badges = progress["badges"] or ["none yet"]
    print(f"{BOLD}badges:{RESET} {', '.join(badges)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list")
    p = sub.add_parser("start")
    p.add_argument("chapter")
    p.add_argument("--force", action="store_true")
    for name in ("run", "verify"):
        p = sub.add_parser(name)
        p.add_argument("chapter")
        p.add_argument("--tier", choices=TIER_ORDER)
    sub.add_parser("status")
    args = parser.parse_args(argv)
    return {
        "list": cmd_list,
        "start": cmd_start,
        "run": cmd_run,
        "verify": cmd_verify,
        "status": cmd_status,
    }[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
