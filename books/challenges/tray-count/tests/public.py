"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("trays").trays_needed

    def test_statement_samples(self):
        self.assertEqual(self.solve(180), (15, 0))
        self.assertEqual(self.solve(310), (26, 2))
        self.assertEqual(self.solve(0), (0, 0))
        self.assertEqual(self.solve(25, 10), (3, 5))
        self.assertEqual(self.solve(1, 10), (1, 9))


if __name__ == "__main__":
    unittest.main()
