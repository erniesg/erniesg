"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("balance").first_balancing_line

    def test_statement_samples(self):
        self.assertEqual(self.solve([300, 500, 200, 700], 700), 2)
        self.assertEqual(self.solve([300, 500, 200, 700], 1000), 3)
        self.assertEqual(self.solve([-250, 250], 0), 1)
        self.assertEqual(self.solve([700], 1400), -1)
        self.assertEqual(self.solve([], 0), -1)


if __name__ == "__main__":
    unittest.main()
