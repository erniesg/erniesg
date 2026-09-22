"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("race").finishing_order

    def test_statement_samples(self):
        self.assertEqual(
            self.solve(["mia", "sam", "ada"], [31, 48, 29]), ["ada", "mia", "sam"]
        )
        self.assertEqual(self.solve(["sam", "ada"], [29, 29]), ["ada", "sam"])
        self.assertEqual(self.solve(["hal"], [7]), ["hal"])
        self.assertEqual(self.solve([], []), [])


if __name__ == "__main__":
    unittest.main()
