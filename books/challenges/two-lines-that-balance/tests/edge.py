"""Edge tier: the cases where a line tries to pair with itself."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("balance").first_balancing_line

    def test_nothing_to_reconcile(self):
        self.assertEqual(self.solve([], 0), -1)
        self.assertEqual(self.solve([], 500), -1)
        self.assertEqual(self.solve([500], 500), -1)

    def test_a_line_cannot_pair_with_itself(self):
        self.assertEqual(self.solve([700], 1400), -1)
        self.assertEqual(self.solve([0], 0), -1)
        self.assertEqual(self.solve([350, 100], 700), -1)

    def test_two_copies_of_half_the_target_do_pair(self):
        self.assertEqual(self.solve([700, 700], 1400), 1)
        self.assertEqual(self.solve([0, 0], 0), 1)

    def test_earliest_completing_line_not_earliest_pair(self):
        # 100 + 400 completes at position 3; 200 + 300 completes at position 2.
        self.assertEqual(self.solve([100, 200, 300, 400], 500), 2)

    def test_negative_amounts(self):
        self.assertEqual(self.solve([-500, -200, 700], 500), 2)
        self.assertEqual(self.solve([-500, -500], -1000), 1)
        self.assertEqual(self.solve([1000, -1000], 0), 1)

    def test_no_pair_anywhere(self):
        self.assertEqual(self.solve([1, 2, 4, 8, 16], 100), -1)

    def test_ends_of_the_range(self):
        self.assertEqual(self.solve([1_000_000, 1_000_000], 2_000_000), 1)
        self.assertEqual(self.solve([-1_000_000, -1_000_000], -2_000_000), 1)
        self.assertEqual(self.solve([-1_000_000, 1_000_000], 0), 1)

    def test_the_answer_is_the_last_line(self):
        self.assertEqual(self.solve([5, 7, 9, 11], 20), 3)

    def test_the_file_comes_back_untouched(self):
        amounts = [300, 500, 200, 700]
        self.solve(amounts, 700)
        self.assertEqual(amounts, [300, 500, 200, 700], msg="the list you were given was changed")


if __name__ == "__main__":
    unittest.main()
