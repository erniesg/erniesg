"""Edge tier: both ends of the allowed range, and the type of the answer."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("digits").sum_of_two_digits

    def test_range_ends(self):
        self.assertEqual(self.solve(0, 9), 9)
        self.assertEqual(self.solve(9, 0), 9)

    def test_returns_a_number_not_text(self):
        result = self.solve(4, 5)
        self.assertIsInstance(result, int, msg="return the number, not text")
        self.assertEqual(result, 9)


if __name__ == "__main__":
    unittest.main()
