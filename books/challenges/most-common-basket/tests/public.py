"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("baskets").most_common_basket

    def test_statement_samples(self):
        self.assertEqual(self.solve([["milk"], ["bread"], ["milk"]]), ["milk"])
        self.assertEqual(
            self.solve([["milk", "eggs"], ["eggs", "milk"]]), ["milk", "eggs"]
        )
        self.assertEqual(self.solve([["tea"]]), ["tea"])
        self.assertEqual(self.solve([]), [])


if __name__ == "__main__":
    unittest.main()
