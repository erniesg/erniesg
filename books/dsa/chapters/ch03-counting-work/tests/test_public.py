"""ch03 public tier: visible examples."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.first_duplicate = load_solution("dedup").first_duplicate

    def test_examples(self):
        self.assertEqual(self.first_duplicate(["a.jpg", "b.png", "a.jpg"]), "a.jpg")
        self.assertEqual(self.first_duplicate(["a", "b", "b", "a"]), "b")
        self.assertIsNone(self.first_duplicate(["a", "b"]))


if __name__ == "__main__":
    unittest.main()
