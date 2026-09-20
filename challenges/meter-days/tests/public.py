"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("meter").days_of_credit

    def test_statement_samples(self):
        self.assertEqual(self.solve(10, [3, 4]), 3)
        self.assertEqual(self.solve(0, [5]), 0)
        self.assertEqual(self.solve(6, [2, 0, 0]), 9)
        self.assertEqual(self.solve(4, [0, 0]), -1)


if __name__ == "__main__":
    unittest.main()
