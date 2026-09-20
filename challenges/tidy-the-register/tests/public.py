"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("register").tidy_names

    def test_statement_samples(self):
        self.assertEqual(self.solve(["  mia ", "sam"]), ["mia", "sam"])
        self.assertEqual(self.solve(["ada", "   ", "hal "]), ["ada", "hal"])
        self.assertEqual(self.solve(["   "]), [])
        self.assertEqual(self.solve([]), [])


if __name__ == "__main__":
    unittest.main()
