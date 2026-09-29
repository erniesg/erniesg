"""Run one grading tier inside this interpreter instead of a subprocess.

The published site grades in the reader's browser, in Pyodide, where there is
no subprocess to start. This runs a tier file exactly as `grade.run_tier` has a
fresh Python run it: the same environment variables, the same `bookgrader`
recording and `grader_observe` verdicts, `unittest.main()` from the tier's own
`__main__` block. It then puts the interpreter back as it found it, so the next
tier (or the next reader's attempt) starts clean. `test_grade_inprocess.py`
holds it to the same answers as the subprocess grader.

A run cannot be stopped from in here: the caller owns the time limit (the
browser terminates the worker that runs this).
"""

from __future__ import annotations

import atexit
import json
import os
import runpy
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from grading import UNRECORDED_TIERS, BoundedText, summarize  # noqa: E402

GRADER_MODULES = ("bookgrader", "grader_observe")
GRADER_ENV = ("BOOK_SOLUTION_DIR", "BOOK_CALL_LOG", "BOOK_SAMPLE_MODE")


def _inside(path: object, roots: tuple[Path, ...]) -> bool:
    if not isinstance(path, str):
        return False
    resolved = Path(path).resolve()
    return any(resolved.is_relative_to(root) for root in roots)


def run_tier(node_dir: Path, tier: str, solution_dir: Path, sample: bool = False) -> dict:
    """One tier: `{"outcome", "output", "calls", "total", "summary"}`.

    `outcome` is "pass", "fail" or "missing", as `grade.run_tier` says it.
    """
    node_dir, solution_dir = Path(node_dir).resolve(), Path(solution_dir).resolve()
    test_file = node_dir / "tests" / f"{tier}.py"
    if not test_file.is_file():
        output = f"No test file at {test_file}"
        return {"outcome": "missing", "output": output, "calls": [], "total": 0, "summary": output}
    record = tier not in UNRECORDED_TIERS

    saved_env = {name: os.environ.get(name) for name in GRADER_ENV}
    saved_modules = set(sys.modules)
    saved_case = dict(vars(unittest.TestCase))
    saved_cwd, saved_argv = os.getcwd(), list(sys.argv)
    # grade.py sets PYTHONDONTWRITEBYTECODE: a cached .pyc of the reader's last
    # attempt, same size and same second, would otherwise be imported instead.
    saved_bytecode = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    for name in GRADER_MODULES:  # imported fresh, so they read this tier's environment
        sys.modules.pop(name, None)

    # Bounded as it is written: the perf tier is never recorded, so a print in
    # its hot loop lands here, and must not fill the tab before the time limit.
    buffer = BoundedText()
    code = 0
    calls: list[dict] = []
    total = 0
    with tempfile.TemporaryDirectory() as scratch:
        log = Path(scratch) / "calls.json"
        os.environ["BOOK_SOLUTION_DIR"] = str(solution_dir)
        for name in ("BOOK_CALL_LOG", "BOOK_SAMPLE_MODE"):
            os.environ.pop(name, None)
        if record:
            os.environ["BOOK_CALL_LOG"] = str(log)
            if sample:
                os.environ["BOOK_SAMPLE_MODE"] = "1"
        try:
            os.chdir(node_dir)
            sys.argv = [str(test_file)]
            with redirect_stdout(buffer), redirect_stderr(buffer):
                try:
                    runpy.run_path(str(test_file), run_name="__main__")
                except SystemExit as done:
                    code = done.code if isinstance(done.code, int) else (0 if done.code is None else 1)
                except BaseException as error:  # a tier file that breaks is a failing tier
                    import traceback

                    traceback.print_exception(error, file=buffer)
                    code = 1
        finally:
            grader = sys.modules.get("bookgrader")
            recorder = getattr(grader, "_RECORDER", None)
            if recorder is not None:
                recorder.flush()  # what atexit does when the subprocess ends
                atexit.unregister(recorder.flush)
            os.chdir(saved_cwd)
            sys.argv = saved_argv
            sys.dont_write_bytecode = saved_bytecode
            for name, value in saved_env.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
            for name in list(vars(unittest.TestCase)):
                if name not in saved_case:
                    delattr(unittest.TestCase, name)
            for name, value in saved_case.items():
                if vars(unittest.TestCase).get(name) is not value:
                    setattr(unittest.TestCase, name, value)
            roots = (solution_dir, node_dir)
            for name in set(sys.modules) - saved_modules:
                module = sys.modules.get(name)
                if name in GRADER_MODULES or _inside(getattr(module, "__file__", None), roots):
                    sys.modules.pop(name, None)
        if record and log.is_file():
            try:
                logged = json.loads(log.read_text())
                calls = list(logged.get("calls", []))
                total = int(logged.get("total", len(calls)))
            except (OSError, ValueError, TypeError):
                calls, total = [], 0

    output = buffer.getvalue().strip()
    outcome = "pass" if code == 0 else "fail"
    return {
        "outcome": outcome,
        "output": output,
        "calls": calls,
        "total": total,
        "summary": "" if outcome == "pass" else summarize(output, test_file),
    }


def run_tier_json(node_dir: str, tier: str, solution_dir: str, sample: bool = False) -> str:
    """`run_tier` as a JSON string: what the browser's worker hands back."""
    return json.dumps(run_tier(Path(node_dir), tier, Path(solution_dir), sample))
