"""Stress tier: against a slow counter that is obviously right.

The referee counts one name at a time by searching the whole log for it. That
is far too slow for the real limits and completely transparent on small logs,
which is exactly what a referee is for.
"""

import itertools
import random
import unittest

from bookgrader import load_solution


def slow_tally(names):
    """Obviously correct: for each distinct name, count it in the list."""
    result = {}
    for name in names:
        result[name] = names.count(name)
    return result


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("tally").tally_visits

    def test_every_short_log_exhaustively(self):
        for length in range(0, 5):
            for log in itertools.product("abc", repeat=length):
                names = list(log)
                self.assertEqual(
                    self.solve(names),
                    slow_tally(names),
                    msg=f"failed on {names}",
                )

    def test_random_logs(self):
        rng = random.Random(20260920)
        people = ["ada", "grace", "alan", "katherine", "dorothy"]
        for _ in range(400):
            names = [rng.choice(people) for _ in range(rng.randint(0, 60))]
            self.assertEqual(self.solve(names), slow_tally(names), msg=f"failed on {names}")

    def test_random_logs_of_mostly_unique_names(self):
        rng = random.Random(4242)
        for _ in range(200):
            names = ["".join(rng.choices("abcdefghij", k=rng.randint(1, 3))) for _ in range(30)]
            self.assertEqual(self.solve(names), slow_tally(names), msg=f"failed on {names}")


if __name__ == "__main__":
    unittest.main()
