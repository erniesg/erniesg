"""Edge tier: the promise the card makes, and the cases a sample never shows."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("ledger").replay

    def test_a_refused_fare_leaves_the_balance_alone(self):
        balance, rejected = self.solve([100, -500, -100])
        self.assertEqual(balance, 0, msg="the refused 500 must not have been taken")
        self.assertEqual(rejected, [1])

    def test_exactly_empty_is_allowed(self):
        self.assertEqual(self.solve([300, -300]), (0, []))
        self.assertEqual(self.solve([300, -300, -1]), (0, [2]))

    def test_every_entry_refused(self):
        self.assertEqual(self.solve([-1, -2, -3]), (0, [0, 1, 2]))

    def test_nothing_refused(self):
        self.assertEqual(self.solve([10, 20, -5, 30]), (55, []))

    def test_zero_is_applied_and_never_refused(self):
        self.assertEqual(self.solve([0, 0]), (0, []))
        self.assertEqual(self.solve([0, -1, 0]), (0, [1]))

    def test_a_later_top_up_does_not_rescue_an_earlier_fare(self):
        # The 400 arrives after the fare was already turned away.
        self.assertEqual(self.solve([-400, 400]), (400, [0]))

    def test_the_same_fare_can_be_refused_then_accepted(self):
        self.assertEqual(self.solve([-100, 250, -100]), (150, [0]))

    def test_positions_are_in_order_and_zero_based(self):
        _, rejected = self.solve([-1, 5, -9, 1, -100])
        self.assertEqual(rejected, [0, 2, 4])

    def test_range_ends(self):
        self.assertEqual(
            self.solve([1_000_000, -1_000_000]), (0, [])
        )
        self.assertEqual(self.solve([-1_000_000]), (0, [0]))

    def test_input_is_left_alone(self):
        amounts = [500, -200, -400, 100]
        self.solve(amounts)
        self.assertEqual(
            amounts, [500, -200, -400, 100], msg="do not edit the list you were given"
        )

    def test_returns_a_pair_of_the_right_shapes(self):
        balance, rejected = self.solve([5, -9])
        self.assertIsInstance(balance, int)
        self.assertIsInstance(rejected, list)


if __name__ == "__main__":
    unittest.main()
