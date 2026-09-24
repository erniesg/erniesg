"""Public tier: the prices printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("ticket").ticket_price

    def test_statement_samples(self):
        self.assertEqual(self.solve(4), 0)
        self.assertEqual(self.solve(5), 350)
        self.assertEqual(self.solve(17), 350)
        self.assertEqual(self.solve(18), 620)
        self.assertEqual(self.solve(64), 620)
        self.assertEqual(self.solve(65), 400)


if __name__ == "__main__":
    unittest.main()
