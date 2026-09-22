"""Stress tier: every short shelf over three labels, against a plodding referee.

The referee walks positions and copies the survivors forward. Short shelves
over a tiny set of labels is where runs of the same label turn up on their
own, which is the case that breaks a walk-and-remove answer.
"""

import itertools
import unittest

from bookgrader import load_solution

LABELS = ["beans", "rice", "soup"]


def referee(items, unwanted):
    kept = []
    for i in range(len(items)):
        if items[i] != unwanted:
            kept.append(items[i])
    return kept


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("shelf").without

    def test_every_short_shelf(self):
        for length in range(0, 5):
            for shelf in itertools.product(LABELS, repeat=length):
                for unwanted in LABELS + ["pasta"]:
                    given = list(shelf)
                    answer = self.solve(given, unwanted)
                    self.assertEqual(
                        answer,
                        referee(list(shelf), unwanted),
                        msg=f"failed on items={list(shelf)}, unwanted={unwanted!r}",
                    )
                    self.assertEqual(
                        given,
                        list(shelf),
                        msg=f"the shelf was edited on items={list(shelf)}, "
                        f"unwanted={unwanted!r}",
                    )
                    self.assertIsNot(
                        answer,
                        given,
                        msg=f"handed the caller's own list back on items={list(shelf)}",
                    )

    def test_no_copy_ever_survives(self):
        """Whatever else happens, the recalled label must not be in the answer."""
        for length in range(0, 7):
            shelf = [LABELS[i % 3] for i in range(length)]
            answer = self.solve(list(shelf), "beans")
            self.assertNotIn("beans", answer, msg=f"a copy survived on items={shelf}")
            self.assertEqual(
                len(answer),
                len(shelf) - shelf.count("beans"),
                msg=f"wrong number left on items={shelf}",
            )


if __name__ == "__main__":
    unittest.main()
