"""Edge tier: the cases where rider numbers lie and the board is nearly empty."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("timing").closest_ascent

    def test_nothing_to_compare(self):
        self.assertEqual(self.solve([]), -1)
        self.assertEqual(self.solve([(1, 0)]), -1)

    def test_two_ascents(self):
        self.assertEqual(self.solve([(1, 0), (2, 3_000_000)]), 3_000_000)
        self.assertEqual(self.solve([(1, 7), (2, 7)]), 0)

    def test_rider_order_is_not_time_order(self):
        # Sorted by rider the times read 100, 400, 900, 300 and the smallest
        # neighbouring gap is 300. Sorted by time the closest pair is 100 apart.
        ascents = [(3, 900), (2, 400), (1, 100), (4, 300)]
        self.assertEqual(self.solve(ascents), 100)

    def test_closest_pair_is_far_apart_in_the_input(self):
        ascents = [(1, 10), (2, 5_000), (3, 90_000), (4, 11)]
        self.assertEqual(self.solve(ascents), 1)

    def test_repeated_times_win_over_everything(self):
        self.assertEqual(self.solve([(1, 5), (2, 9), (3, 5), (4, 40)]), 0)

    def test_same_rider_twice(self):
        self.assertEqual(self.solve([(8, 1_000), (8, 1_004), (8, 2_000)]), 4)

    def test_ends_of_the_range(self):
        self.assertEqual(self.solve([(1, 0), (1_000_000, 1)]), 1)
        self.assertEqual(self.solve([(1, 3_000_000), (2, 2_999_999)]), 1)

    def test_all_gaps_equal(self):
        self.assertEqual(self.solve([(n, n * 25) for n in range(1, 40)]), 25)

    def test_the_board_comes_back_untouched(self):
        ascents = [(7, 100), (2, 900), (5, 400)]
        self.solve(ascents)
        self.assertEqual(ascents, [(7, 100), (2, 900), (5, 400)])


if __name__ == "__main__":
    unittest.main()
