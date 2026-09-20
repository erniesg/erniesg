"""Edge tier: ties, zeros, the ends of the range, and the order of the answer."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("standings").riders_you_beat

    def test_empty_board(self):
        self.assertEqual(self.solve([]), [])

    def test_one_ascent(self):
        self.assertEqual(self.solve([0]), [0])
        self.assertEqual(self.solve([1_000_000]), [0])

    def test_everybody_tied(self):
        self.assertEqual(self.solve([7] * 6), [0] * 6)

    def test_ties_do_not_beat_each_other(self):
        self.assertEqual(self.solve([2, 2, 1, 1, 3]), [2, 2, 0, 0, 4])

    def test_zero_is_a_real_time(self):
        self.assertEqual(self.solve([0, 0, 5]), [0, 0, 2])

    def test_already_in_order(self):
        self.assertEqual(self.solve([10, 20, 30, 40]), [0, 1, 2, 3])

    def test_reversed_order(self):
        self.assertEqual(self.solve([40, 30, 20, 10]), [3, 2, 1, 0])

    def test_ends_of_the_range_together(self):
        self.assertEqual(self.solve([1_000_000, 0]), [1, 0])

    def test_answer_follows_the_input_order_not_the_time_order(self):
        self.assertEqual(self.solve([900, 100, 900, 100]), [2, 0, 2, 0])

    def test_answer_is_a_list_of_plain_numbers(self):
        answer = self.solve([5, 1])
        self.assertIsInstance(answer, list)
        self.assertEqual(answer, [1, 0])

    def test_the_board_comes_back_untouched(self):
        times = [300, 100, 200]
        self.solve(times)
        self.assertEqual(times, [300, 100, 200], msg="the list you were given was changed")


if __name__ == "__main__":
    unittest.main()
