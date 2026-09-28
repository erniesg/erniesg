"""Helpers used by chapter tests to load the code under grade.

Tests never import learner code directly. They call ``load_solution`` with a
module name declared in the node's front matter; the runner points
``BOOK_SOLUTION_DIR`` at either the learner workspace (``run``) or the
node's reference solution (``verify``), so the same tests grade both.
"""

from __future__ import annotations

import atexit
import functools
import importlib.util
import io
import json
import os
import reprlib
import sys
import types
import unittest
from collections import deque
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


class GraderSetupError(RuntimeError):
    pass


def solution_dir() -> Path:
    root = os.environ.get("BOOK_SOLUTION_DIR")
    if not root:
        raise GraderSetupError(
            "BOOK_SOLUTION_DIR is not set. Run tests through "
            "`python3 books/tools/grade.py <node>` instead of directly."
        )
    path = Path(root)
    if not path.is_dir():
        raise GraderSetupError(f"BOOK_SOLUTION_DIR does not exist: {path}")
    return path


def load_solution(module_name: str):
    """Import ``<BOOK_SOLUTION_DIR>/<module_name>.py`` and return the module."""
    path = solution_dir() / f"{module_name}.py"
    if not path.is_file():
        raise GraderSetupError(
            f"Expected solution file is missing: {path}\n"
            f"Did you run `python3 books/tools/grade.py start <node>`?"
        )
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise GraderSetupError(f"Could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    if _RECORDER is not None:
        return _Recorded(module)
    return module


# ---------------------------------------------------------------------------
# What the reader printed, call by call
# ---------------------------------------------------------------------------
#
# When the grader sets ``BOOK_CALL_LOG``, every call the tests make into the
# reader's functions runs with its own stdout and stderr captured, and is
# written down: the call, what came back (or what it raised), and what it
# printed. The unittest runner's own output (progress dots, tracebacks) never
# reaches these buffers, so a reader's ``print`` is shown on its own, under the
# call that made it, instead of buried in the runner's dump.
#
# ``BOOK_SAMPLE_MODE`` runs the same tests without grading: assertions only
# record whether the answer matched, and a raise is recorded and swallowed, so
# every sample row runs even when the first is wrong.

OUTPUT_LIMIT_BYTES = 20_000  # per call; a print in a hot loop must not flood the page
KEEP_FIRST, KEEP_LAST = 40, 10  # the failing call is always the most recent one

_short = reprlib.Repr()
_short.maxlist = _short.maxtuple = _short.maxset = _short.maxdict = 12
_short.maxstring = _short.maxother = 80
_short.maxlevel = 3


def _clip(text: str) -> tuple[str, int]:
    """At most OUTPUT_LIMIT_BYTES of whole lines, and how many lines were dropped."""
    data = text.encode()
    if len(data) <= OUTPUT_LIMIT_BYTES:
        return text, 0
    kept = data[:OUTPUT_LIMIT_BYTES].decode(errors="ignore")
    if "\n" in kept:
        kept = kept[: kept.rfind("\n") + 1]
    return kept, text.count("\n") - kept.count("\n")


class _BoundedBuffer(io.StringIO):
    """Stops keeping text past the limit, so a flood costs memory once, not forever."""

    def __init__(self):
        super().__init__()
        self.size = 0
        self.dropped_lines = 0

    def write(self, text):
        if self.size > OUTPUT_LIMIT_BYTES:
            self.dropped_lines += text.count("\n")
            return len(text)
        self.size += len(text.encode())
        return super().write(text)


class _Recorder:
    def __init__(self, path: str, sample: bool):
        self.path = path
        self.sample = sample
        self.first: list[dict] = []
        self.last: deque[dict] = deque(maxlen=KEEP_LAST)
        self.total = 0
        self.latest: dict | None = None
        atexit.register(self.flush)

    def keep(self, record: dict) -> None:
        self.total += 1
        record["index"] = self.total
        self.latest = record
        if len(self.first) < KEEP_FIRST:
            self.first.append(record)
        else:
            self.last.append(record)

    def flush(self) -> None:
        calls = self.first + list(self.last)
        for record in calls:
            record.pop("_result_id", None)
        try:
            Path(self.path).write_text(json.dumps({"calls": calls, "total": self.total}))
        except OSError:
            pass


def _current_test() -> str:
    frame = sys._getframe(2)
    while frame is not None:
        owner = frame.f_locals.get("self")
        if isinstance(owner, unittest.TestCase):
            return getattr(owner, "_testMethodName", "")
        frame = frame.f_back
    return ""


class _NoAnswer:
    """What a sample call hands back after it raised: equal to nothing."""

    def __repr__(self):
        return "(raised)"

    def __eq__(self, other):
        return False

    __hash__ = object.__hash__


def _finish(record: dict, out: _BoundedBuffer, err: _BoundedBuffer, recorder: _Recorder) -> None:
    text, dropped = _clip(out.getvalue())
    record["out"] = text
    record["out_dropped_lines"] = dropped + out.dropped_lines
    errors, dropped_err = _clip(err.getvalue())
    record["err"] = errors
    record["err_dropped_lines"] = dropped_err + err.dropped_lines
    recorder.keep(record)


def _wrap(function, recorder: _Recorder):
    @functools.wraps(function)
    def call(*args, **kwargs):
        shown = ", ".join(
            [_short.repr(a) for a in args] + [f"{k}={_short.repr(v)}" for k, v in kwargs.items()]
        )
        record = {"test": _current_test(), "call": f"{function.__name__}({shown})"}
        out, err = _BoundedBuffer(), _BoundedBuffer()
        try:
            with redirect_stdout(out), redirect_stderr(err):
                result = function(*args, **kwargs)
        except Exception as error:  # the reader's code raised; it belongs to this call
            record["raised"] = f"{type(error).__name__}: {error}".rstrip(": ")
            _finish(record, out, err, recorder)
            if recorder.sample:
                return _NoAnswer()
            raise
        record["returned"] = _short.repr(result)
        record["_result_id"] = id(result)
        _finish(record, out, err, recorder)
        return result

    return call


class _Recorded(types.ModuleType):
    """The reader's module, with each of its own functions recording its calls.

    The module itself is untouched, so the reader's recursion and internal
    calls are not recorded, only the calls the tests make.
    """

    def __init__(self, module):
        super().__init__(module.__name__)
        self._module = module
        self._cache = {}

    def __getattr__(self, name):
        value = getattr(self._module, name)
        if isinstance(value, types.FunctionType) and value.__module__ == self._module.__name__:
            if name not in self._cache:
                self._cache[name] = _wrap(value, _RECORDER)
            return self._cache[name]
        return value


_RECORDER: _Recorder | None = None
if os.environ.get("BOOK_CALL_LOG"):
    from grader_observe import observe

    _RECORDER = _Recorder(os.environ["BOOK_CALL_LOG"], os.environ.get("BOOK_SAMPLE_MODE") == "1")
    observe(_RECORDER, _short.repr)
