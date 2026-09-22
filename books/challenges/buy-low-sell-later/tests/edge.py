"""Edge tier: the shapes where order matters and `max - min` falls over."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("resale").best_gain

    def test_nothing_to_work_with(self):
        self.assertEqual(self.solve([]), 0)
        self.assertEqual(self.solve([500]), 0)

    def test_high_before_low(self):
        # max is 9 and min is 1, but the 9 came first: you cannot sell backwards.
        self.assertEqual(self.solve([9, 1]), 0)
        self.assertEqual(self.solve([100, 90, 80, 1]), 0)

    def test_the_low_after_the_high_is_not_the_answer(self):
        # max - min says 8; the only legal gain is 4 - 2.
        self.assertEqual(self.solve([9, 2, 4, 1]), 2)

    def test_two_readings(self):
        self.assertEqual(self.solve([1, 2]), 1)
        self.assertEqual(self.solve([2, 1]), 0)
        self.assertEqual(self.solve([4, 4]), 0)

    def test_cannot_buy_and_sell_at_the_same_reading(self):
        self.assertEqual(self.solve([5, 5, 5, 5]), 0)

    def test_ends_of_the_range(self):
        self.assertEqual(self.solve([0, 1_000_000]), 1_000_000)
        self.assertEqual(self.solve([1_000_000, 0]), 0)

    def test_best_pair_sits_in_the_middle(self):
        self.assertEqual(self.solve([8, 9, 1, 7, 2, 3]), 6)

    def test_the_input_list_comes_back_untouched(self):
        prices = [7, 1, 5, 3, 6, 4]
        self.solve(prices)
        self.assertEqual(prices, [7, 1, 5, 3, 6, 4], msg="the list you were given was changed")


if __name__ == "__main__":
    unittest.main()
