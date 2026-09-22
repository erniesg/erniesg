"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("split").split_bill

    def test_statement_samples(self):
        self.assertEqual(self.solve(100, 4), (25, 0))
        self.assertEqual(self.solve(101, 4), (25, 1))
        self.assertEqual(self.solve(3, 5), (0, 3))
        self.assertEqual(self.solve(50, 0), (0, 0))


if __name__ == "__main__":
    unittest.main()
