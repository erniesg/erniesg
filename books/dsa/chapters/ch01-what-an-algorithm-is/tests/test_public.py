"""ch01 public tier: visible examples."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.add = load_solution("warmup").add

    def test_examples(self):
        self.assertEqual(self.add(2, 3), 5)
        self.assertEqual(self.add(9, 7), 16)
        self.assertEqual(self.add(0, 0), 0)


if __name__ == "__main__":
    unittest.main()
