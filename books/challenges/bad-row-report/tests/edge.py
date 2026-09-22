"""Edge tier: blank lines that must still be counted, and rows that never raise."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("rows").parse_amounts

    def test_blank_lines_still_move_the_line_number(self):
        total, problems = self.solve(["", "", "oops", "10"])
        self.assertEqual(total, 10)
        self.assertEqual(problems, [(3, "oops")], msg="blank lines still count as lines")

    def test_every_line_bad(self):
        self.assertEqual(
            self.solve(["a", "b"]), (0, [(1, "a"), (2, "b")])
        )

    def test_only_blank_lines(self):
        self.assertEqual(self.solve(["", "   ", "\t"]), (0, []))

    def test_zero_is_an_amount_not_a_problem(self):
        self.assertEqual(self.solve(["0", "0000"]), (0, []))

    def test_minus_zero_is_not_below_zero(self):
        self.assertEqual(self.solve(["-0"]), (0, []))

    def test_problems_hold_the_line_exactly_as_it_arrived(self):
        total, problems = self.solve(["  not a number  "])
        self.assertEqual(total, 0)
        self.assertEqual(
            problems,
            [(1, "  not a number  ")],
            msg="report the original text, spaces and all",
        )

    def test_problems_come_back_in_line_order(self):
        _, problems = self.solve(["x", "5", "y", "6", "z"])
        self.assertEqual([number for number, _ in problems], [1, 3, 5])

    def test_decimals_and_signs_and_spaces_inside(self):
        _, problems = self.solve(["3.0", "1 2", "12a", " -7 "])
        self.assertEqual([number for number, _ in problems], [1, 2, 3, 4])

    def test_a_bad_row_never_raises(self):
        try:
            self.solve(["twelve", "", "3.0", "-1", "9"])
        except TypeError:
            raise
        except Exception as problem:  # noqa: BLE001 - the point of the test
            self.fail(f"a messy row must be reported, not raised: {problem!r}")

    def test_not_a_list_raises_type_error(self):
        for wrong in (None, "1200\n850", 17, {"1": "2"}):
            with self.assertRaises(TypeError, msg=f"should have refused {wrong!r}"):
                self.solve(wrong)

    def test_returns_a_pair_of_the_right_shapes(self):
        total, problems = self.solve(["5", "no"])
        self.assertIsInstance(total, int)
        self.assertIsInstance(problems, list)
        self.assertIsInstance(problems[0], tuple)


if __name__ == "__main__":
    unittest.main()
