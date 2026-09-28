"""The grader's watch on assertions, kept out of the reader's tracebacks.

unittest drops frames from any module that defines ``__unittest``, so a failed
assertion still reads as the test's own line, the line ``grade.summarize``
turns into "f(args) returned X, expected Y". That is why this lives apart from
``bookgrader``: its call wrapper must stay visible, since a reader's exception
passes through it and the reader needs their own line numbers.

Every assertion a test makes about the reader's latest answer records a verdict
on that call: what was expected, and whether it held. Grading is unchanged:
the original assertion still runs and still fails. In sample mode a failing
assertion is recorded and not raised, so every sample row runs.
"""

from __future__ import annotations

import unittest

__unittest = True

# Assertions about one value, and what the verdict should say was expected.
ONE_VALUE = {
    "assertTrue": lambda: "a true value",
    "assertFalse": lambda: "a false value",
    "assertIsNone": lambda: "None",
    "assertIsNotNone": lambda: "anything but None",
}
# Assertions comparing the answer (first argument) with a second value.
TWO_VALUES = {
    "assertEqual": "",
    "assertNotEqual": "not ",
    "assertIs": "",
    "assertIsNot": "not ",
    "assertIn": "one of ",
    "assertNotIn": "none of ",
    "assertLess": "less than ",
    "assertLessEqual": "at most ",
    "assertGreater": "more than ",
    "assertGreaterEqual": "at least ",
    "assertCountEqual": "the same items as ",
    "assertAlmostEqual": "about ",
}


def observe(recorder, shorten) -> None:
    def about_latest(first):
        """The latest call, if this assertion is about its answer and has no verdict yet."""
        latest = recorder.latest
        if latest is None or "match" in latest:
            return None
        if latest.get("_result_id") == id(first) or "raised" in latest:
            return latest
        return None

    def checked(name, expected_text):
        original = getattr(unittest.TestCase, name)

        def assertion(self, first, *rest, **kwargs):
            latest = about_latest(first)
            try:
                original(self, first, *rest, **kwargs)
            except self.failureException:
                if latest is not None:
                    latest["expected"] = expected_text(rest)
                    latest["match"] = False
                    recorder.mark_bad(latest)
                if recorder.sample:
                    return None
                raise
            if latest is not None:
                # It held. After a call that raised, that means the test itself
                # caught the raise and found it expected (a test may compare
                # ("raised", "TypeError") tuples), so the call was right.
                latest["expected"] = expected_text(rest)
                latest["match"] = True
            return None

        setattr(unittest.TestCase, name, assertion)

    for name, text in ONE_VALUE.items():
        checked(name, lambda rest, text=text: text())
    for name, prefix in TWO_VALUES.items():
        checked(name, lambda rest, prefix=prefix: prefix + (shorten(rest[0]) if rest else ""))

    # `with self.assertRaises(E): solve(...)`: the reader's exception must reach
    # the context manager, so in sample mode the call re-raises it (see
    # `raising`), and the verdict is whether the right kind came out.
    original_raises = unittest.TestCase.assertRaises

    def assertRaises(self, expected, *args, **kwargs):
        if args:  # the callable form; not used by the samples, left exactly as is
            return original_raises(self, expected, *args, **kwargs)
        context = original_raises(self, expected, **kwargs)
        kinds = expected if isinstance(expected, tuple) else (expected,)
        wanted = " or ".join(getattr(kind, "__name__", str(kind)) for kind in kinds)

        class Watching:
            def __enter__(self_inner):
                recorder.expecting_raise = True
                return context.__enter__()

            def __exit__(self_inner, kind, value, trace):
                recorder.expecting_raise = False
                latest = recorder.latest
                raised_right = kind is not None and issubclass(kind, kinds)
                if latest is not None and "match" not in latest:
                    latest["expected"] = f"raises {wanted}"
                    latest["match"] = raised_right
                    if not raised_right:
                        recorder.mark_bad(latest)
                try:
                    return context.__exit__(kind, value, trace)
                except self.failureException:
                    if recorder.sample:
                        return True  # recorded; the rest of the samples still run
                    raise

        return Watching()

    unittest.TestCase.assertRaises = assertRaises
