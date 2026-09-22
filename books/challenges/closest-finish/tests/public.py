"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("timing").closest_ascent

    def test_statement_samples(self):
        self.assertEqual(self.solve([(7, 100), (2, 900), (5, 400)]), 300)
        self.assertEqual(self.solve([(9, 40), (4, 55), (1, 42)]), 2)
        self.assertEqual(self.solve([(1, 500), (2, 500)]), 0)
        self.assertEqual(self.solve([(3, 1200)]), -1)
        self.assertEqual(self.solve([]), -1)


if __name__ == "__main__":
    unittest.main()
