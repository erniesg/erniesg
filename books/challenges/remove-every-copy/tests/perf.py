"""Perf tier: a full warehouse shelf, half of it recalled.

One pass costs 200,000 steps. Removing one copy at a time makes the list close
the gap after each of the 100,000 matches, which moves billions of labels.
"""

import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.0
SIZE = 200_000


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("shelf").without

    def test_half_the_shelf_recalled(self):
        shelf = ["beans" if i % 2 == 0 else "rice" for i in range(SIZE)]
        started = time.perf_counter()
        answer = self.solve(shelf, "beans")
        elapsed = time.perf_counter() - started
        self.assertEqual(len(answer), SIZE // 2)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=(
                f"took {elapsed:.2f}s on {SIZE} items — one pass is enough, "
                f"and repeated removal is not one pass"
            ),
        )


if __name__ == "__main__":
    unittest.main()
