#!/usr/bin/env python3
"""Grade one challenge node, tier by tier.

  python3 challenges/tools/grade.py start max-pairwise-product   copy starter to workspace
  python3 challenges/tools/grade.py run   max-pairwise-product   grade your workspace code
  python3 challenges/tools/grade.py verify max-pairwise-product  grade the reference solution

Tiers run in order and stop at the first failure: public, edge, stress, perf.
Stdlib only; needs Python 3.11+ for tomllib.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

if sys.version_info < (3, 11):  # tomllib arrived in 3.11
    sys.exit(f"This needs Python 3.11+; this is Python {sys.version.split()[0]}.")

import tomllib

CHALLENGES_DIR = Path(__file__).resolve().parent.parent
WORKSPACE_DIR = CHALLENGES_DIR / "workspace"
TIERS = ["public", "edge", "stress", "perf"]

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"


def read_front_matter(path: Path) -> dict:
    """Read the +++ TOML +++ block at the top of a node file."""
    text = path.read_text()
    if not text.startswith("+++"):
        raise SystemExit(f"{path} does not start with a +++ front matter block")
    _, raw, _ = text.split("+++", 2)
    return tomllib.loads(raw)


def load_node(node_id: str) -> tuple[Path, dict]:
    node_dir = CHALLENGES_DIR / node_id
    challenge = node_dir / "challenge.md"
    if not challenge.is_file():
        raise SystemExit(f"No challenge at {challenge}")
    return node_dir, read_front_matter(challenge)


def start(node_id: str, force: bool) -> int:
    node_dir, meta = load_node(node_id)
    target = WORKSPACE_DIR / node_id
    module = f"{meta['module']}.py"
    if (target / module).exists() and not force:
        print(f"{target / module} already exists; pass --force to reset it.")
        return 1
    target.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(node_dir / "starter.py", target / module)
    print(f"Copied the starter to {target / module}")
    print(f"  edit it, then: python3 challenges/tools/grade.py run {node_id}")
    return 0


def run_tier(node_dir: Path, tier: str, solution_dir: Path, timeout: int) -> tuple[str, str]:
    test_file = node_dir / "tests" / f"{tier}.py"
    if not test_file.is_file():
        return "missing", f"No test file at {test_file}"
    env = {
        **os.environ,
        "BOOK_SOLUTION_DIR": str(solution_dir),
        "PYTHONPATH": str(CHALLENGES_DIR / "tools"),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    try:
        done = subprocess.run(
            [sys.executable, str(test_file)],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            cwd=node_dir,
        )
    except subprocess.TimeoutExpired:
        return "timeout", f"exceeded the {timeout}s limit"
    output = (done.stdout + done.stderr).strip()
    return ("pass" if done.returncode == 0 else "fail"), output


FRAME = re.compile(r'^\s*File "([^"]+)", line (\d+)', re.MULTILINE)
ASSERTION = re.compile(r"^AssertionError: (.*?)(?: : (.*))?$", re.MULTILINE)
EXCEPTION = re.compile(r"^(\w+(?:Error|Exception|Exit|Interrupt)|NotImplementedError)(?::\s?(.*))?$", re.MULTILINE)
SOLVE_CALL = re.compile(r"self\.solve\((.*)\)\s*,")
FUNCTION = re.compile(r'load_solution\([^)]*\)\.(\w+)')


def summarize(output: str, test_file: Path | None = None) -> str:
    """The one line a reader needs from a failing tier, not the unittest dump.

    An assertion becomes `f(args) returned X, expected Y`, with the test's own
    message (usually the failing input) when it has one. An exception raised
    in the reader's code names the error and the line of their file it came
    from. Anything else falls back to the last line of the output.
    """
    if not output:
        return ""
    if output.startswith("exceeded the"):
        return f"too slow: {output} on the biggest allowed input. Look for work you repeat."
    name = "your function"
    if test_file and test_file.is_file():
        found = FUNCTION.search(test_file.read_text())
        if found:
            name = found.group(1)

    frames = FRAME.findall(output)
    user_frames = [
        (path, line) for path, line in frames
        if "/tests/" not in path and "bookgrader" not in path and "unittest" not in path
    ]
    failure = ASSERTION.search(output)
    if failure and not user_frames:
        comparison, message = failure.group(1), failure.group(2)
        # the source lines unittest printed between the test frame and the error
        shown = output[: failure.start()].rsplit('File "', 1)[-1]
        call = SOLVE_CALL.search(" ".join(line.strip() for line in shown.splitlines()))
        if " != " in comparison:
            got, expected = comparison.split(" != ", 1)
            subject = f"{name}({call.group(1)})" if call else name
            text = f"{subject} returned {got}, expected {expected}"
            return f"{text} \u2014 {message}" if message and not call else text
        return message or comparison

    exception = None
    for match in EXCEPTION.finditer(output):
        exception = match
    if exception:
        what = exception.group(1) + (f": {exception.group(2)}" if exception.group(2) else "")
        if user_frames:
            return f"your code raised {what} on line {user_frames[-1][1]}"
        return what
    return output.strip().splitlines()[-1]


def grade(node_id: str, use_solution: bool) -> int:
    node_dir, meta = load_node(node_id)
    if use_solution:
        solution_dir = WORKSPACE_DIR / ".reference" / node_id
        solution_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(node_dir / "solution.py", solution_dir / f"{meta['module']}.py")
    else:
        solution_dir = WORKSPACE_DIR / node_id
        if not (solution_dir / f"{meta['module']}.py").is_file():
            print(f"Nothing to grade yet. Run: grade.py start {node_id}")
            return 1

    print(f"\n{meta['title']}  {DIM}({node_id}){RESET}")
    print(f"{DIM}grading {solution_dir}{RESET}\n")

    earned = 0
    for tier in TIERS:
        config = meta.get("tiers", {}).get(tier, {})
        outcome, output = run_tier(node_dir, tier, solution_dir, config.get("timeout", 60))
        if outcome == "pass":
            xp = config.get("xp", 0)
            earned += xp
            print(f"  {GREEN}✔ {tier:<7}{RESET} passed  (+{xp} XP)")
            continue
        label = {"fail": "failed", "timeout": "TIME LIMIT EXCEEDED", "missing": "missing"}[outcome]
        print(f"  {RED}✘ {tier:<7} {label}{RESET}")
        summary = summarize(output, node_dir / "tests" / f"{tier}.py")
        if summary:
            print(f"\n    {summary}")
        if output:
            print("\n" + "\n".join("    " + line for line in output.splitlines()[-25:]))
        print(f"\n  {DIM}Tiers stop at the first failure. Fix this one first.{RESET}")
        return 1

    print(f"\n  {GREEN}all four tiers green{RESET}  (+{earned} XP)\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("start", "run", "verify"):
        p = sub.add_parser(name)
        p.add_argument("node")
        if name == "start":
            p.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if args.command == "start":
        return start(args.node, args.force)
    return grade(args.node, use_solution=args.command == "verify")


if __name__ == "__main__":
    raise SystemExit(main())
