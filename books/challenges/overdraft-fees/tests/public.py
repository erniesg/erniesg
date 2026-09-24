"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("overdraft").overdraft_cost

    def test_statement_samples(self):
        self.assertEqual(self.solve(12000, [4500, 3000, 2800, 4000, 1900]), (1600, -4200))
        self.assertEqual(self.solve(1000, [1000]), (0, 0))
        self.assertEqual(self.solve(500, []), (0, 500))
        self.assertEqual(self.solve(100, [50, 50, 50]), (800, -50))


if __name__ == "__main__":
    unittest.main()
