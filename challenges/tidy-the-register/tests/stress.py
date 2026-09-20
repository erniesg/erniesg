"""Stress tier: against an obvious slow reference, on small random sheets.

The reference below is deliberately dull: walk the entries, trim, keep the
ones with something left. Nothing clever can hide in it. The sheets are tiny
and full of blanks, because runs of consecutive blanks are where a
delete-while-walking answer falls apart.
"""

import random
import unittest

from bookgrader import load_solution

PIECES = ["mia", "sam", "ada", "hal", "mary jane", "", " ", "   "]
PADDING = ["", " ", "  "]


def obviously_correct(names):
    tidy = []
    for name in names:
        trimmed = name.strip()
        if trimmed:
            tidy.append(trimmed)
    return tidy


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("register").tidy_names

    def test_random_small_sheets(self):
        rng = random.Random(20260920)
        for _ in range(600):
            sheet = []
            for _ in range(rng.randint(0, 6)):
                piece = rng.choice(PIECES)
                sheet.append(rng.choice(PADDING) + piece + rng.choice(PADDING))
            kept = list(sheet)
            self.assertEqual(
                self.solve(sheet),
                obviously_correct(kept),
                msg=f"wrong answer for {kept!r}",
            )
            self.assertEqual(sheet, kept, msg=f"the input list was changed: {kept!r}")

    def test_runs_of_blanks_exhaustively(self):
        # Every arrangement of blank and non-blank up to five entries long.
        for size in range(0, 6):
            for pattern in range(2**size):
                sheet = [
                    "  " if (pattern >> place) & 1 else f"name{place} "
                    for place in range(size)
                ]
                kept = list(sheet)
                self.assertEqual(
                    self.solve(sheet),
                    obviously_correct(kept),
                    msg=f"wrong answer for {kept!r}",
                )
                self.assertEqual(sheet, kept, msg=f"the input list was changed: {kept!r}")


if __name__ == "__main__":
    unittest.main()
