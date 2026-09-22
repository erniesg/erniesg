"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("digits").sum_of_two_digits

    def test_statement_samples(self):
        self.assertEqual(self.solve(9, 7), 16)
        self.assertEqual(self.solve(0, 0), 0)
        self.assertEqual(self.solve(9, 9), 18)


if __name__ == "__main__":
    unittest.main()
