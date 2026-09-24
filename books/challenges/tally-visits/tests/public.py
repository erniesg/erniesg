"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("tally").tally_visits

    def test_statement_samples(self):
        self.assertEqual(self.solve(["ada", "grace", "ada"]), {"ada": 2, "grace": 1})
        self.assertEqual(self.solve(["alan"]), {"alan": 1})
        self.assertEqual(self.solve(["ada", "ada", "ada"]), {"ada": 3})
        self.assertEqual(self.solve([]), {})


if __name__ == "__main__":
    unittest.main()
