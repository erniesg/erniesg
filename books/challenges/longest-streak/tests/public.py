"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("streak").longest_streak

    def test_statement_samples(self):
        self.assertEqual(self.solve([True, True, False, True]), 2)
        self.assertEqual(self.solve([True, True, True]), 3)
        self.assertEqual(
            self.solve([False, True, False, True, True, True, False]), 3
        )
        self.assertEqual(self.solve([False, False]), 0)
        self.assertEqual(self.solve([]), 0)


if __name__ == "__main__":
    unittest.main()
