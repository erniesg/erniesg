"""Perf tier: a large settings file, read line by line.

Each line is at the stated length limit. Reading one line is cheap; building the
answer one character at a time is not.
"""

import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.5


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("setting").parse_setting

    def test_thirty_thousand_full_length_lines(self):
        value = "/volumes/backup/" + "d" * 960
        line = "   PATH =  " + value + "   \n"
        self.assertLessEqual(len(line), 1_000)

        started = time.perf_counter()
        for _ in range(30_000):
            result = self.solve(line)
        elapsed = time.perf_counter() - started

        self.assertEqual(result, ("path", value))
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s — gluing the value together character by character is why",
        )


if __name__ == "__main__":
    unittest.main()
