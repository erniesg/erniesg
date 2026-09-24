"""Edge tier: no payments at all, zero itself, every payment a dip, the range ends."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("overdraft").overdraft_cost

    def test_no_payments_reports_the_starting_balance(self):
        self.assertEqual(self.solve(0, []), (0, 0))
        self.assertEqual(self.solve(1_000_000, []), (0, 1_000_000))

    def test_exactly_zero_is_not_below_zero(self):
        self.assertEqual(self.solve(1000, [400, 600]), (0, 0))
        self.assertEqual(self.solve(0, [0, 0, 0]), (0, 0))

    def test_every_payment_dips_and_is_charged_every_time(self):
        self.assertEqual(self.solve(0, [1, 1, 1]), (2400, -3))

    def test_charged_once_per_payment_not_once_per_month(self):
        # Under after the second payment and still under after the third.
        self.assertEqual(self.solve(100, [60, 60, 60]), (1600, -80))

    def test_a_low_before_a_dip_is_still_the_low(self):
        # The lowest point is reached in the middle, not at the end.
        self.assertEqual(self.solve(10, [30, 0, 0]), (2400, -20))

    def test_range_ends(self):
        self.assertEqual(self.solve(1_000_000, [1_000_000]), (0, 0))
        self.assertEqual(self.solve(0, [1_000_000]), (800, -1_000_000))

    def test_returns_a_pair_of_whole_numbers(self):
        result = self.solve(12000, [4500, 3000, 2800, 4000, 1900])
        self.assertIsInstance(result, tuple, msg="return a pair: (charged, lowest)")
        self.assertEqual(len(result), 2)
        charged, lowest = result
        self.assertIsInstance(charged, int)
        self.assertIsInstance(lowest, int)

    def test_the_lowest_is_never_above_the_start(self):
        for payments in ([], [0], [7], [7, 0, 7]):
            _, lowest = self.solve(50, payments)
            self.assertLessEqual(lowest, 50, msg=f"failed on payments {payments}")


if __name__ == "__main__":
    unittest.main()
