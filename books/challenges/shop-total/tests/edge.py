"""Edge tier: the ends of the range, and the type of the answer."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("shop").shop_total

    def test_range_ends(self):
        self.assertEqual(self.solve("1000", 1000), 1_000_000)
        self.assertEqual(self.solve("0", 0), 0)

    def test_returns_a_number_not_repeated_text(self):
        result = self.solve("25", 4)
        self.assertIsInstance(result, int, msg="convert the price before multiplying")
        self.assertEqual(result, 100)

    def test_leading_zero_text_still_converts(self):
        self.assertEqual(self.solve("007", 2), 14)


if __name__ == "__main__":
    unittest.main()
