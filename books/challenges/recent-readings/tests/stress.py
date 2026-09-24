"""Stress tier: every small log and every small screen, against a plodding referee.

The referee works out where the tail starts, then copies forward one position
at a time. Nobody would write it that way, which is exactly why it is easy to
trust.
"""

import random
import unittest

from bookgrader import load_solution


def referee(readings, n):
    start = len(readings) - n
    if start < 0:
        start = 0
    out = []
    for i in range(start, len(readings)):
        out.append(readings[i])
    return out


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("recent").recent

    def test_small_logs_exhaustively(self):
        for length in range(0, 7):
            log = [(i * 7) % 5 for i in range(length)]  # short, with repeats
            for n in range(0, 9):
                given = list(log)
                answer = self.solve(given, n)
                self.assertEqual(
                    answer,
                    referee(log, n),
                    msg=f"failed on readings={log}, n={n}",
                )
                self.assertEqual(
                    given, log, msg=f"the log was changed on readings={log}, n={n}"
                )
                self.assertIsNot(
                    answer, given, msg=f"handed back the caller's list on {log}, n={n}"
                )

    def test_random_logs(self):
        rng = random.Random(20260920)
        for _ in range(500):
            log = [rng.randint(0, 9) for _ in range(rng.randint(0, 40))]
            n = rng.randint(0, 45)
            given = list(log)
            self.assertEqual(
                self.solve(given, n),
                referee(log, n),
                msg=f"failed on readings={log}, n={n}",
            )
            self.assertEqual(given, log, msg=f"the log was changed on readings={log}, n={n}")


if __name__ == "__main__":
    unittest.main()
