"""Edge tier: the lists that end inside a run, and the ones with no run at all."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("streak").longest_streak

    def test_a_run_that_reaches_the_last_day_still_counts(self):
        self.assertEqual(self.solve([False, True, True]), 2)
        self.assertEqual(self.solve([True] * 50), 50)

    def test_one_day(self):
        self.assertEqual(self.solve([True]), 1)
        self.assertEqual(self.solve([False]), 0)

    def test_every_other_day(self):
        self.assertEqual(self.solve([True, False] * 20), 1)

    def test_the_best_run_is_in_the_middle(self):
        self.assertEqual(
            self.solve([True, False, True, True, True, False, True]), 3
        )

    def test_an_earlier_run_is_not_overwritten_by_a_later_shorter_one(self):
        self.assertEqual(self.solve([True, True, True, False, True]), 3)

    def test_answer_is_a_whole_number(self):
        self.assertIsInstance(self.solve([True, True]), int)

    def test_input_is_left_alone(self):
        days = [True, False, True, True]
        self.solve(days)
        self.assertEqual(days, [True, False, True, True], msg="do not edit the list")


if __name__ == "__main__":
    unittest.main()
