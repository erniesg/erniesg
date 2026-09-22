"""Stress tier: against a referee that searches lists, plus the rules the answer must obey.

The referee is the slow version from hint 1 — no sets anywhere, so there is
nothing in it to get wrong. On lists of five items its slowness costs nothing.
"""

import itertools
import random
import unittest

from bookgrader import load_solution


def slow_missing(requested, stocked):
    """Obviously correct: search both lists, one name at a time."""
    answer = []
    for name in requested:
        if name not in stocked and name not in answer:
            answer.append(name)
    return answer


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("stock").missing_items

    def test_every_small_case_exhaustively(self):
        parts = "abc"
        bin_options = []
        for size in range(0, 3):
            bin_options.extend(list(combo) for combo in itertools.product(parts, repeat=size))
        for length in range(0, 4):
            for combo in itertools.product(parts, repeat=length):
                requested = list(combo)
                for stocked in bin_options:
                    self.assertEqual(
                        self.solve(requested, stocked),
                        slow_missing(requested, stocked),
                        msg=f"failed on requested={requested}, stocked={stocked}",
                    )

    def test_random_cases_against_the_referee(self):
        rng = random.Random(20260920)
        parts = ["tube", "cable", "pads", "chain", "spoke", "grease"]
        for _ in range(400):
            requested = [rng.choice(parts) for _ in range(rng.randint(0, 20))]
            stocked = [rng.choice(parts) for _ in range(rng.randint(0, 8))]
            self.assertEqual(
                self.solve(requested, stocked),
                slow_missing(requested, stocked),
                msg=f"failed on requested={requested}, stocked={stocked}",
            )

    def test_the_rules_always_hold(self):
        rng = random.Random(777)
        parts = ["a", "b", "c", "d", "e"]
        for _ in range(300):
            requested = [rng.choice(parts) for _ in range(rng.randint(0, 15))]
            stocked = [rng.choice(parts) for _ in range(rng.randint(0, 5))]
            answer = self.solve(requested, stocked)
            case = f"requested={requested}, stocked={stocked}, answer={answer}"
            self.assertEqual(len(answer), len(set(answer)), msg=f"repeated a name: {case}")
            for name in answer:
                self.assertIn(name, requested, msg=f"invented a name: {case}")
                self.assertNotIn(name, stocked, msg=f"already in the bin: {case}")
            first_asked = [n for n in dict.fromkeys(requested) if n not in stocked]
            self.assertEqual(answer, first_asked, msg=f"wrong order or missing name: {case}")


if __name__ == "__main__":
    unittest.main()
