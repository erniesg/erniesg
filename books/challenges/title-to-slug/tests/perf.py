"""Perf tier: a page's worth of titles.

Nothing here is hard work, so this tier only catches a method that grows badly
with the length of the title.
"""

import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.5


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("slug").title_to_slug

    def test_twenty_thousand_full_length_titles(self):
        title = "   " + "   ".join(["Word"] * 25) + "   "  # 178 characters, ragged spacing
        self.assertLessEqual(len(title), 200)
        expected = "-".join(["word"] * 25)

        started = time.perf_counter()
        for _ in range(20_000):
            result = self.solve(title)
        elapsed = time.perf_counter() - started

        self.assertEqual(result, expected)
        self.assertLess(elapsed, TIME_LIMIT_SECONDS, msg=f"took {elapsed:.2f}s")


if __name__ == "__main__":
    unittest.main()
