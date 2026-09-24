"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("barrier").count_repeat_visitors

    def test_statement_samples(self):
        self.assertEqual(self.solve(["AB1", "CD2", "AB1"]), 1)
        self.assertEqual(self.solve(["AB1", "AB1", "AB1"]), 1)
        self.assertEqual(self.solve(["AB1", "CD2", "EF3"]), 0)
        self.assertEqual(self.solve(["AB1", "CD2", "AB1", "CD2"]), 2)


if __name__ == "__main__":
    unittest.main()
