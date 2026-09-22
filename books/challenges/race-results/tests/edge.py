"""Edge tier: everybody tied, repeated names, the ends of the clock."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("race").finishing_order

    def test_all_the_same_time(self):
        self.assertEqual(
            self.solve(["sam", "ada", "mia"], [40, 40, 40]), ["ada", "mia", "sam"]
        )

    def test_two_swimmers_share_a_name(self):
        self.assertEqual(self.solve(["ada", "ada"], [50, 20]), ["ada", "ada"])
        self.assertEqual(self.solve(["ada", "ada", "bob"], [50, 20, 30]), ["ada", "bob", "ada"])

    def test_ends_of_the_clock(self):
        self.assertEqual(
            self.solve(["slow", "fast"], [1_000_000, 0]), ["fast", "slow"]
        )

    def test_already_in_order_and_backwards(self):
        self.assertEqual(self.solve(["a", "b", "c"], [1, 2, 3]), ["a", "b", "c"])
        self.assertEqual(self.solve(["a", "b", "c"], [3, 2, 1]), ["c", "b", "a"])

    def test_time_beats_the_alphabet(self):
        # "zoe" is last alphabetically and first past the wall.
        self.assertEqual(self.solve(["ada", "zoe"], [99, 1]), ["zoe", "ada"])

    def test_both_input_lists_come_back_untouched(self):
        names = ["mia", "sam", "ada"]
        seconds = [31, 48, 29]
        self.solve(names, seconds)
        self.assertEqual(names, ["mia", "sam", "ada"], msg="the names list was changed")
        self.assertEqual(seconds, [31, 48, 29], msg="the times list was changed")


if __name__ == "__main__":
    unittest.main()
