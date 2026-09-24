"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("stock").missing_items

    def test_statement_samples(self):
        self.assertEqual(
            self.solve(["tube", "cable", "tube", "pads"], ["pads", "tube"]), ["cable"]
        )
        self.assertEqual(self.solve(["tube", "cable", "cable"], []), ["tube", "cable"])
        self.assertEqual(self.solve(["tube"], ["tube", "tube"]), [])
        self.assertEqual(self.solve([], ["tube"]), [])


if __name__ == "__main__":
    unittest.main()
