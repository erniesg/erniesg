"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("cable").longest_lead

    def test_statement_samples(self):
        self.assertEqual(self.solve([900, 2000, 1400], 4), 900)
        self.assertEqual(self.solve([900, 2000, 1400], 10), 400)
        self.assertEqual(self.solve([900, 1400], 3000), 0)
        self.assertEqual(self.solve([], 1), 0)


if __name__ == "__main__":
    unittest.main()
