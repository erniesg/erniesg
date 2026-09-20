"""Edge tier: free days, no credit, an exact number of trips, and the range ends."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("meter").days_of_credit

    def test_a_pattern_that_costs_nothing_never_runs_out(self):
        self.assertEqual(self.solve(0, [0]), -1)
        self.assertEqual(self.solve(1_000_000_000, [0, 0, 0]), -1)

    def test_no_credit_at_all(self):
        self.assertEqual(self.solve(0, [1]), 0)
        self.assertEqual(self.solve(0, [1_000_000]), 0)

    def test_free_days_at_the_front_are_still_covered(self):
        # Day one costs nothing, so it is covered even on an empty meter.
        self.assertEqual(self.solve(0, [0, 1]), 1)
        self.assertEqual(self.solve(5, [0, 3]), 3)

    def test_an_exact_number_of_trips(self):
        self.assertEqual(self.solve(7, [3, 4]), 2)
        self.assertEqual(self.solve(14, [3, 4]), 4)

    def test_a_single_day_pattern(self):
        self.assertEqual(self.solve(10, [3]), 3)
        self.assertEqual(self.solve(9, [3]), 3)
        self.assertEqual(self.solve(2, [3]), 0)

    def test_range_ends(self):
        # Scale belongs to the perf tier; these are the shapes at the ends of
        # the range, not the sizes.
        self.assertEqual(self.solve(1_000_000_000, [1_000_000]), 1000)
        self.assertEqual(self.solve(999_999, [1_000_000]), 0)
        self.assertEqual(self.solve(1_000_000_000, [1_000_000] * 1000), 1000)

    def test_returns_a_whole_number(self):
        self.assertIsInstance(self.solve(10, [3, 4]), int, msg="use // rather than /")


if __name__ == "__main__":
    unittest.main()
