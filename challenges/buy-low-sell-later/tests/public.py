"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("resale").best_gain

    def test_statement_samples(self):
        self.assertEqual(self.solve([7, 1, 5, 3, 6, 4]), 5)
        self.assertEqual(self.solve([9, 8, 7]), 0)
        self.assertEqual(self.solve([3, 3, 3]), 0)
        self.assertEqual(self.solve([]), 0)


if __name__ == "__main__":
    unittest.main()
