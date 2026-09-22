"""Edge tier: nobody to pay, one person, and the ends of the range."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("split").split_bill

    def test_nobody_to_pay_does_not_raise(self):
        self.assertEqual(self.solve(0, 0), (0, 0))
        self.assertEqual(self.solve(999, 0), (0, 0))

    def test_one_person_pays_everything(self):
        self.assertEqual(self.solve(777, 1), (777, 0))

    def test_nothing_to_split(self):
        self.assertEqual(self.solve(0, 7), (0, 0))

    def test_range_ends(self):
        self.assertEqual(self.solve(1_000_000, 1000), (1000, 0))
        self.assertEqual(self.solve(1_000_000, 999), (1001, 1))

    def test_returns_whole_numbers(self):
        each, left = self.solve(101, 4)
        self.assertIsInstance(each, int, msg="use // rather than /")
        self.assertIsInstance(left, int)


if __name__ == "__main__":
    unittest.main()
