"""Edge tier: the default itself, exact fits, one-portion trays, the range ends."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("trays").trays_needed

    def test_the_default_is_twelve(self):
        self.assertEqual(self.solve(12), (1, 0))
        self.assertEqual(self.solve(13), (2, 11))
        self.assertEqual(self.solve(12), self.solve(12, 12))

    def test_named_argument_at_the_call(self):
        self.assertEqual(self.solve(25, per_tray=10), (3, 5))
        self.assertEqual(self.solve(portions=25, per_tray=10), (3, 5))

    def test_one_portion_still_needs_a_whole_tray(self):
        self.assertEqual(self.solve(1), (1, 11))
        self.assertEqual(self.solve(1, 1000), (1, 999))

    def test_trays_of_one_leave_nothing_spare(self):
        self.assertEqual(self.solve(0, 1), (0, 0))
        self.assertEqual(self.solve(7, 1), (7, 0))
        self.assertEqual(self.solve(1_000_000, 1), (1_000_000, 0))

    def test_exact_fits_do_not_gain_a_tray(self):
        for per_tray in (1, 2, 7, 12, 999, 1000):
            trays, spare = self.solve(per_tray * 9, per_tray)
            self.assertEqual((trays, spare), (9, 0), msg=f"failed at per_tray {per_tray}")

    def test_range_ends(self):
        self.assertEqual(self.solve(1_000_000, 1000), (1000, 0))
        self.assertEqual(self.solve(1_000_000, 999), (1002, 998))
        self.assertEqual(self.solve(0, 1000), (0, 0))

    def test_returns_a_pair_of_whole_numbers(self):
        result = self.solve(310)
        self.assertIsInstance(result, tuple, msg="return a pair: (trays, spare)")
        self.assertEqual(len(result), 2)
        trays, spare = result
        self.assertIsInstance(trays, int, msg="use // rather than /")
        self.assertIsInstance(spare, int)


if __name__ == "__main__":
    unittest.main()
