"""ch01 edge tier: boundaries — zeros, negatives, huge magnitudes."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.add = load_solution("warmup").add

    def test_negatives(self):
        self.assertEqual(self.add(-5, 3), -2)
        self.assertEqual(self.add(-5, -5), -10)

    def test_identity_and_cancellation(self):
        self.assertEqual(self.add(0, 41), 41)
        self.assertEqual(self.add(123456789, -123456789), 0)

    def test_huge_magnitudes(self):
        big = 10**10_000
        self.assertEqual(self.add(big, 1), big + 1)
        self.assertEqual(self.add(-big, -big), -2 * big)

    def test_returns_int_not_float(self):
        self.assertIsInstance(self.add(1, 2), int)


if __name__ == "__main__":
    unittest.main()
