"""Edge tier: the lines that hold nothing, and the ones that only look like they do."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("setting").parse_setting

    def test_lines_that_hold_no_setting(self):
        for line in ["", "   ", "\t\n", "#", "   # keep = 30", "just a sentence", "="]:
            self.assertIsNone(self.solve(line), msg=f"{line!r} holds no setting")

    def test_a_key_that_is_only_whitespace(self):
        self.assertIsNone(self.solve("   =   value"))

    def test_newline_and_tabs_are_whitespace(self):
        self.assertEqual(self.solve("\tkeep\t=\t30\t\n"), ("keep", "30"))
        self.assertEqual(self.solve("keep = 30\n"), ("keep", "30"))

    def test_value_keeps_its_case_and_the_key_does_not(self):
        self.assertEqual(self.solve("Disk = /Volumes/Backup"), ("disk", "/Volumes/Backup"))
        self.assertEqual(self.solve("KEY = VALUE"), ("key", "VALUE"))

    def test_empty_value_is_a_setting_not_a_blank_line(self):
        self.assertEqual(self.solve("retries="), ("retries", ""))
        self.assertEqual(self.solve("  retries =    "), ("retries", ""))

    def test_hash_inside_a_line_is_an_ordinary_character(self):
        self.assertEqual(self.solve("color = #ff0000"), ("color", "#ff0000"))
        self.assertEqual(self.solve("note = keep # forever"), ("note", "keep # forever"))

    def test_only_the_first_equals_cuts(self):
        self.assertEqual(self.solve("a==b"), ("a", "=b"))
        self.assertEqual(self.solve("query = x=1&y=2"), ("query", "x=1&y=2"))

    def test_spaces_inside_the_value_survive(self):
        self.assertEqual(self.solve("greeting =  hello   world  "), ("greeting", "hello   world"))

    def test_a_key_may_hold_spaces(self):
        self.assertEqual(self.solve("Max Retries = 3"), ("max retries", "3"))

    def test_the_value_is_text_not_a_number(self):
        key, value = self.solve("keep = 30")
        self.assertIsInstance(key, str)
        self.assertIsInstance(value, str, msg="leave the value as text; the caller converts it")
        self.assertEqual((key, value), ("keep", "30"))

    def test_the_longest_line_allowed(self):
        value = "x" * 900
        line = "  path = " + value + "  "
        self.assertLessEqual(len(line), 1_000)
        self.assertEqual(self.solve(line), ("path", value))


if __name__ == "__main__":
    unittest.main()
