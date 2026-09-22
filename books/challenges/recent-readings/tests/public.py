"""Public tier: the rows printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("recent").recent

    def test_statement_samples(self):
        self.assertEqual(self.solve([3, 8, 2, 9, 4], 2), [9, 4])
        self.assertEqual(self.solve([3, 8, 2], 7), [3, 8, 2])
        self.assertEqual(self.solve([3, 8, 2], 0), [])
        self.assertEqual(self.solve([], 5), [])


if __name__ == "__main__":
    unittest.main()
