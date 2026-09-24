"""Stress tier: every legal input, compared against the obvious answer."""

import unittest

from bookgrader import load_solution


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("digits").sum_of_two_digits

    def test_every_legal_pair(self):
        # Only 100 of them exist, so check all of them rather than sampling.
        for a in range(10):
            for b in range(10):
                self.assertEqual(self.solve(a, b), a + b, msg=f"failed on {a}, {b}")


if __name__ == "__main__":
    unittest.main()
