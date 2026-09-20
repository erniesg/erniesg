"""ch03 edge tier: empty input, unicode, adjacency, tricky ordering."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.first_duplicate = load_solution("dedup").first_duplicate

    def test_empty_and_single(self):
        self.assertIsNone(self.first_duplicate([]))
        self.assertIsNone(self.first_duplicate(["only.png"]))

    def test_adjacent_duplicate(self):
        self.assertEqual(self.first_duplicate(["x", "x"]), "x")

    def test_second_occurrence_order_decides(self):
        # "late" is seen first, but "early"'s *second* occurrence comes first.
        self.assertEqual(
            self.first_duplicate(["late", "early", "early", "late"]), "early"
        )

    def test_triple_occurrence_returns_at_second_sighting(self):
        self.assertEqual(self.first_duplicate(["a", "b", "a", "a"]), "a")

    def test_unicode_paths(self):
        paths = ["记者/照片.jpg", "récap/été.png", "记者/照片.jpg"]
        self.assertEqual(self.first_duplicate(paths), "记者/照片.jpg")

    def test_similar_but_distinct_strings(self):
        self.assertIsNone(self.first_duplicate(["a.jpg", "a.jpg ", " a.jpg", "A.jpg"]))

    def test_empty_string_is_a_value(self):
        self.assertEqual(self.first_duplicate(["", "x", ""]), "")


if __name__ == "__main__":
    unittest.main()
