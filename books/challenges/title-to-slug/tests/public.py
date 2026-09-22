"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("slug").title_to_slug

    def test_statement_samples(self):
        self.assertEqual(self.solve("Reading the Deal"), "reading-the-deal")
        self.assertEqual(self.solve("  Two   Pointers  "), "two-pointers")
        self.assertEqual(self.solve("Chapter 7"), "chapter-7")
        self.assertEqual(self.solve("   "), "")


if __name__ == "__main__":
    unittest.main()
