"""The grader's watch on assertions, kept out of the reader's tracebacks.

unittest drops frames from any module that defines ``__unittest``, so a failed
assertion still reads as the test's own line, the line ``grade.summarize``
turns into "f(args) returned X, expected Y". That is why this lives apart from
``bookgrader``: its call wrapper must stay visible, since a reader's exception
passes through it and the reader needs their own line numbers.
"""

from __future__ import annotations

import unittest

__unittest = True

QUIETED = (
    "assertTrue", "assertFalse", "assertIn", "assertNotIn", "assertIs", "assertIsNot",
    "assertLess", "assertLessEqual", "assertGreater", "assertGreaterEqual", "assertNotEqual",
    "assertCountEqual", "assertAlmostEqual", "assertIsNone", "assertIsNotNone",
)


def observe(recorder, shorten) -> None:
    """Note on the latest call whether its answer matched what the test expected.

    Grading is unchanged: the original assertion still runs and still fails.
    Only in sample mode is a mismatch recorded and not raised.
    """
    original = unittest.TestCase.assertEqual

    def assertEqual(self, first, second, msg=None):
        latest = recorder.latest
        if latest is not None and "expected" not in latest:
            if latest.get("_result_id") == id(first):
                latest["expected"] = shorten(second)
                latest["match"] = bool(first == second)
            elif "raised" in latest:
                latest["expected"] = shorten(second)
                latest["match"] = False
        if recorder.sample:
            return None
        return original(self, first, second, msg)

    unittest.TestCase.assertEqual = assertEqual
    if recorder.sample:
        for name in QUIETED:
            setattr(unittest.TestCase, name, lambda self, *a, **k: None)
