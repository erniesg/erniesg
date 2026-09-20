"""Edge tier: the caller's list, runs of blanks, and spaces inside a name."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("register").tidy_names

    def test_the_callers_list_comes_back_untouched(self):
        sheet = ["  mia ", "   ", "sam"]
        self.solve(sheet)
        self.assertEqual(
            sheet,
            ["  mia ", "   ", "sam"],
            msg="the list you were handed was changed; build a new one instead",
        )

    def test_returns_a_different_list(self):
        sheet = ["mia", "sam"]
        result = self.solve(sheet)
        self.assertEqual(result, ["mia", "sam"])
        self.assertIsNot(result, sheet, msg="return a new list, not the one you were given")

    def test_consecutive_blanks_are_all_dropped(self):
        self.assertEqual(self.solve(["", "", "ada"]), ["ada"])
        self.assertEqual(self.solve(["ada", "", "", ""]), ["ada"])
        self.assertEqual(self.solve(["", "", ""]), [])

    def test_spaces_inside_a_name_survive(self):
        self.assertEqual(self.solve(["  mary jane  "]), ["mary jane"])
        self.assertEqual(self.solve(["anne-marie o'neill "]), ["anne-marie o'neill"])

    def test_order_is_kept(self):
        self.assertEqual(self.solve([" sam", "ada ", " hal "]), ["sam", "ada", "hal"])

    def test_longest_allowed_entry(self):
        long_name = "z" * 50
        self.assertEqual(self.solve([long_name]), [long_name])


if __name__ == "__main__":
    unittest.main()
