"""The grader's watch on assertions, kept out of the reader's tracebacks.

unittest drops frames from any module that defines ``__unittest``, so a failed
assertion still reads as the test's own line, the line ``grade.summarize``
turns into "f(args) returned X, expected Y". That is why this lives apart from
``bookgrader``: its call wrapper must stay visible, since a reader's exception
passes through it and the reader needs their own line numbers.

Every assertion a test makes records a verdict on the reader's latest call in
that test: what was expected, and whether it held. A passing assertion only
speaks for the call whose answer it examined; a failing one speaks for the
latest call in the same test whatever it examined (a test that checks the
input was left alone, or one part of a returned tuple, is still judging that
call), and a failure always overrides an earlier pass. Grading is unchanged:
the original assertion runs and fails exactly as before. In sample mode a
failure is recorded and not raised, so every sample row runs.
"""

from __future__ import annotations

import unittest

__unittest = True


def _name(kind) -> str:
    kinds = kind if isinstance(kind, tuple) else (kind,)
    return " or ".join(getattr(k, "__name__", str(k)) for k in kinds)


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
    def latest_in(test) -> dict | None:
        latest = recorder.latest
        if latest is None or latest.get("test") != getattr(test, "_testMethodName", None):
            return None
        return latest

    def verdict(latest: dict, held: bool, expected: str) -> None:
        if not held:
            latest["expected"] = expected
            latest["match"] = False
            recorder.mark_bad(latest)
        elif "match" not in latest:
            latest["expected"] = expected
            latest["match"] = True

    def checked(name, expected_text):
        original = getattr(unittest.TestCase, name)

        def assertion(self, first, *rest, **kwargs):
            latest = latest_in(self)
            # a pass only vouches for the call whose answer it looked at (or,
            # after a raise, for a test that caught the raise and expected it)
            about_answer = latest is not None and (
                latest.get("_result_id") == id(first) or "raised" in latest
            )
            try:
                original(self, first, *rest, **kwargs)
            except self.failureException:
                if latest is not None:
                    verdict(latest, False, expected_text(rest))
                if recorder.sample:
                    return None
                raise
            if about_answer:
                verdict(latest, True, expected_text(rest))
            return None

        setattr(unittest.TestCase, name, assertion)

    for name, text in ONE_VALUE.items():
        checked(name, lambda rest, text=text: text())
    for name, prefix in TWO_VALUES.items():
        checked(name, lambda rest, prefix=prefix: prefix + (shorten(rest[0]) if rest else ""))
    checked("assertIsInstance", lambda rest: "an instance of " + (_name(rest[0]) if rest else "?"))
    checked("assertNotIsInstance", lambda rest: "not an instance of " + (_name(rest[0]) if rest else "?"))

    # assertRaises, in both forms. The reader's exception must reach unittest,
    # so while one is expected the recorder re-raises even in sample mode; the
    # verdict is whether the right kind came out. In sample mode a missing or
    # wrong-kind raise is recorded and swallowed, so the next row still runs.
    original_raises = unittest.TestCase.assertRaises

    def judge_raise(test, kinds, kind) -> bool:
        raised_right = kind is not None and issubclass(kind, kinds)
        latest = latest_in(test)
        if latest is not None:
            verdict(latest, raised_right, f"raises {_name(kinds)}")
        return raised_right

    def assertRaises(self, expected, *args, **kwargs):
        kinds = expected if isinstance(expected, tuple) else (expected,)
        if args:  # assertRaises(E, function, *arguments)
            function, *arguments = args
            recorder.expecting_raise = True
            try:
                function(*arguments, **kwargs)
            except BaseException as error:  # judged below, exactly as unittest would
                recorder.expecting_raise = False
                if judge_raise(self, kinds, type(error)):
                    return None
                if recorder.sample:
                    return None
                raise
            finally:
                recorder.expecting_raise = False
            judge_raise(self, kinds, None)
            if recorder.sample:
                return None
            raise self.failureException(f"{_name(kinds)} not raised by {getattr(function, '__name__', function)}")

        context = original_raises(self, expected, **kwargs)

        class Watching:
            def __enter__(self_inner):
                recorder.expecting_raise = True
                return context.__enter__()

            def __exit__(self_inner, kind, value, trace):
                recorder.expecting_raise = False
                raised_right = judge_raise(self, kinds, kind)
                try:
                    handled = context.__exit__(kind, value, trace)
                except self.failureException:
                    if recorder.sample:
                        return True  # nothing was raised: recorded, and the rows go on
                    raise
                if not raised_right and recorder.sample:
                    return True  # the wrong kind: recorded, and swallowed so the rows go on
                return handled

        return Watching()

    unittest.TestCase.assertRaises = assertRaises
