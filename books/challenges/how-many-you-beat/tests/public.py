"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("standings").riders_you_beat

    def test_statement_samples(self):
        self.assertEqual(self.solve([300, 100, 200]), [2, 0, 1])
        self.assertEqual(self.solve([500, 500, 500]), [0, 0, 0])
        self.assertEqual(self.solve([1000, 400, 400, 700]), [3, 0, 0, 2])
        self.assertEqual(self.solve([]), [])


if __name__ == "__main__":
    unittest.main()
