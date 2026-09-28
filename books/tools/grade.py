#!/usr/bin/env python3
"""Grade one challenge node, tier by tier.

  python3 books/tools/grade.py start max-pairwise-product   copy starter to workspace
  python3 books/tools/grade.py run   max-pairwise-product   grade your workspace code
  python3 books/tools/grade.py verify max-pairwise-product  grade the reference solution

Tiers run in order and stop at the first failure: public, edge, stress, perf.
Stdlib only; needs Python 3.11+ for tomllib.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if sys.version_info < (3, 11):  # tomllib arrived in 3.11
    sys.exit(f"This needs Python 3.11+; this is Python {sys.version.split()[0]}.")

import tomllib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render import BOOKS, CHALLENGES, WORKSPACE as WORKSPACE_DIR, report_legacy_workspace
from bookgrader import OUTPUT_LIMIT_BYTES  # noqa: F401  (the cap the page is told about)
from grading import (  # noqa: F401  (grade.summarize and friends stay importable from here)
    ASSERTION, DIFFER, EXCEPTION, FRAME, FUNCTION, SAMPLE_TIER, SOLVE_CALL, TIERS,
    UNRECORDED_TIERS, harness_frame, summarize,
)

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"


def read_front_matter(path: Path) -> dict:
    """Read the +++ TOML +++ block at the top of a node file."""
    text = path.read_text()
    if not text.startswith("+++"):
        raise SystemExit(f"{path} does not start with a +++ front matter block")
    _, raw, _ = text.split("+++", 2)
    return tomllib.loads(raw)


def load_node(node_id: str) -> tuple[Path, dict]:
    node_dir = CHALLENGES / node_id
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
    print(f"  edit it, then: python3 books/tools/grade.py run {node_id}")
    return 0


def run_tier(
    node_dir: Path,
    tier: str,
    solution_dir: Path,
    timeout: int,
    calls: list[dict] | None = None,
    sample: bool = False,
    counts: dict | None = None,
) -> tuple[str, str]:
    """Run one tier. With `calls`, also collect each call the tests made into
    the reader's code: its arguments, its answer, and what it printed. Only
    some calls are kept (the first, the last, and every wrong one up to a
    cap); `counts["total"]` gets how many were actually made."""
    test_file = node_dir / "tests" / f"{tier}.py"
    if not test_file.is_file():
        return "missing", f"No test file at {test_file}"
    env = {
        **os.environ,
        "BOOK_SOLUTION_DIR": str(solution_dir),
        "PYTHONPATH": str(BOOKS / "tools"),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    env.pop("BOOK_CALL_LOG", None)
    env.pop("BOOK_SAMPLE_MODE", None)
    record = calls is not None and tier not in UNRECORDED_TIERS
    with tempfile.TemporaryDirectory() as scratch:
        log = Path(scratch) / "calls.json"
        if record:
            env["BOOK_CALL_LOG"] = str(log)
            if sample:
                env["BOOK_SAMPLE_MODE"] = "1"
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
        if record and log.is_file():
            try:
                logged = json.loads(log.read_text())
                calls.extend(logged.get("calls", []))
                if counts is not None:
                    counts["total"] = int(logged.get("total", len(calls)))
            except (OSError, ValueError, TypeError):
                pass
    output = (done.stdout + done.stderr).strip()
    return ("pass" if done.returncode == 0 else "fail"), output


def run_samples(node_dir: Path, solution_dir: Path, timeout: int) -> dict:
    """Call the reader's code on the statement's samples, without grading.

    Every row runs even when an earlier one is wrong or raises; each comes back
    with its answer, the expected answer, and what it printed. Nothing is
    recorded as solved. A reader whose file cannot even be imported gets that
    error, summarized, instead of an empty list.
    """
    calls: list[dict] = []
    counts: dict = {}
    _, output = run_tier(
        node_dir, SAMPLE_TIER, solution_dir, timeout, calls=calls, sample=True, counts=counts
    )
    error = "" if calls else summarize(output, node_dir / "tests" / f"{SAMPLE_TIER}.py")
    return {"calls": calls, "total": counts.get("total", len(calls)), "error": error}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("start", "run", "verify"):
        p = sub.add_parser(name)
        p.add_argument("node")
        if name == "start":
            p.add_argument("--force", action="store_true")
    args = parser.parse_args()
    report_legacy_workspace()

    if args.command == "start":
        return start(args.node, args.force)
    return grade(args.node, use_solution=args.command == "verify")


if __name__ == "__main__":
    raise SystemExit(main())
