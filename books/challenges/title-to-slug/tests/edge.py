"""Edge tier: no words, one word, spaces everywhere, and the longest title allowed."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("slug").title_to_slug

    def test_empty_title(self):
        result = self.solve("")
        self.assertIsInstance(result, str, msg="return text, even when there is none")
        self.assertEqual(result, "")

    def test_only_spaces(self):
        self.assertEqual(self.solve(" "), "")
        self.assertEqual(self.solve("          "), "")

    def test_one_word(self):
        self.assertEqual(self.solve("Heaps"), "heaps")
        self.assertEqual(self.solve("  heaps  "), "heaps")

    def test_already_lowercase_with_single_spaces(self):
        self.assertEqual(self.solve("two pointers"), "two-pointers")

    def test_a_long_run_of_spaces_is_one_hyphen(self):
        self.assertEqual(self.solve("a" + " " * 30 + "b"), "a-b")

    def test_digits_are_left_alone(self):
        self.assertEqual(self.solve("7 7 7"), "7-7-7")
        self.assertEqual(self.solve("Part 2B"), "part-2b")

    def test_no_hyphen_at_either_end(self):
        result = self.solve("   Bits and Integer Limits   ")
        self.assertFalse(result.startswith("-"), msg=f"leading hyphen in {result!r}")
        self.assertFalse(result.endswith("-"), msg=f"trailing hyphen in {result!r}")
        self.assertEqual(result, "bits-and-integer-limits")

    def test_never_two_hyphens_in_a_row(self):
        result = self.solve("Sliding    Windows   And    Queues")
        self.assertNotIn("--", result, msg=f"doubled hyphen in {result!r}")
        self.assertEqual(result, "sliding-windows-and-queues")

    def test_longest_title_allowed(self):
        title = " ".join(["Word"] * 40)  # 199 characters
        self.assertEqual(len(title), 199)
        self.assertEqual(self.solve(title), "-".join(["word"] * 40))


if __name__ == "__main__":
    unittest.main()
