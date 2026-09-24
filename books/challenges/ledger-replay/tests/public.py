"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("ledger").replay

    def test_statement_samples(self):
        self.assertEqual(self.solve([500, -200, -400, 100]), (400, [2]))
        self.assertEqual(self.solve([200, -50, -300, -50]), (100, [2]))
        self.assertEqual(self.solve([100, -100]), (0, []))
        self.assertEqual(self.solve([-50]), (0, [0]))
        self.assertEqual(self.solve([]), (0, []))


if __name__ == "__main__":
    unittest.main()
