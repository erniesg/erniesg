"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("shortfall").log_shortfalls

    def test_statement_samples(self):
        self.assertEqual(self.solve([200, 150, 180, 90]), [(1, 30), (3, 90)])
        self.assertEqual(self.solve([]), [])
        self.assertEqual(self.solve([5], 10), [(0, 5)])
        self.assertEqual(self.solve([5], 10, [(9, 1)]), [(9, 1), (0, 5)])


if __name__ == "__main__":
    unittest.main()
