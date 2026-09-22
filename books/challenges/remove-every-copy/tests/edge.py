"""Edge tier: neighbours, runs, an untouched shelf, and a list of its own."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("shelf").without

    def test_neighbours_and_runs(self):
        self.assertEqual(self.solve(["beans", "beans"], "rice"), ["beans", "beans"])
        self.assertEqual(
            self.solve(["beans", "beans", "beans", "rice"], "beans"),
            ["rice"],
            msg="three in a row: a walk that removes as it goes skips two of them",
        )
        self.assertEqual(
            self.solve(["rice", "beans", "beans", "soup"], "beans"),
            ["rice", "soup"],
            msg="a pair in the middle",
        )

    def test_order_survives(self):
        shelf = ["soup", "beans", "rice", "beans", "pasta", "beans", "oil"]
        self.assertEqual(self.solve(shelf, "beans"), ["soup", "rice", "pasta", "oil"])

    def test_single_item_shelves(self):
        self.assertEqual(self.solve(["beans"], "beans"), [])
        self.assertEqual(self.solve(["rice"], "beans"), ["rice"])

    def test_the_shelf_comes_back_untouched(self):
        shelf = ["beans", "rice", "beans"]
        self.solve(shelf, "beans")
        self.assertEqual(
            shelf,
            ["beans", "rice", "beans"],
            msg="the caller's shelf was edited instead of a new list being built",
        )

    def test_the_answer_is_a_list_of_its_own(self):
        shelf = ["rice", "soup"]
        answer = self.solve(shelf, "beans")
        self.assertIsNot(answer, shelf, msg="nothing was removed, but it must still be new")
        answer.append("tea")
        self.assertEqual(shelf, ["rice", "soup"])


if __name__ == "__main__":
    unittest.main()
