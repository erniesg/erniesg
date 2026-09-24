"""Public tier: the rows printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("shelf").without

    def test_statement_samples(self):
        self.assertEqual(self.solve(["beans", "rice", "beans"], "beans"), ["rice"])
        self.assertEqual(self.solve(["beans", "beans", "rice"], "beans"), ["rice"])
        self.assertEqual(self.solve(["rice", "soup"], "beans"), ["rice", "soup"])
        self.assertEqual(self.solve(["beans", "beans"], "beans"), [])
        self.assertEqual(self.solve([], "beans"), [])


if __name__ == "__main__":
    unittest.main()
