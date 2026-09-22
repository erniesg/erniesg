"""Edge tier: empty lists, repeats on both sides, and the order of the answer."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("stock").missing_items

    def test_both_empty(self):
        result = self.solve([], [])
        self.assertIsInstance(result, list, msg="return a list, not a set")
        self.assertEqual(result, [])

    def test_empty_bin(self):
        self.assertEqual(self.solve(["tube", "pads"], []), ["tube", "pads"])

    def test_everything_already_there(self):
        self.assertEqual(self.solve(["tube", "pads", "tube"], ["pads", "tube", "chain"]), [])

    def test_a_missing_part_asked_for_many_times_is_listed_once(self):
        self.assertEqual(self.solve(["grease"] * 50, ["tube"]), ["grease"])

    def test_order_is_the_order_first_asked(self):
        requested = ["pads", "grease", "tube", "grease", "spoke", "pads"]
        self.assertEqual(self.solve(requested, ["tube"]), ["pads", "grease", "spoke"])

    def test_returns_a_list_not_a_set(self):
        result = self.solve(["cable", "tube"], [])
        self.assertIsInstance(result, list, msg="a set has no order the caller can trust")
        self.assertEqual(result, ["cable", "tube"])

    def test_names_that_look_alike_stay_apart(self):
        self.assertEqual(self.solve(["pad", "pads", "pa"], ["pad"]), ["pads", "pa"])

    def test_shortest_and_longest_names(self):
        short, long = "a", "z" * 20
        self.assertEqual(self.solve([short, long], [long]), [short])

    def test_the_bin_may_hold_parts_nobody_asked_for(self):
        self.assertEqual(self.solve(["tube"], ["chain", "grease", "pads"]), ["tube"])


if __name__ == "__main__":
    unittest.main()
