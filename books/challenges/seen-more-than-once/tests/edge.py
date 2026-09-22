"""Edge tier: nothing, one read, many reads of one plate, everything twice."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("barrier").count_repeat_visitors

    def test_no_reads(self):
        self.assertEqual(self.solve([]), 0)

    def test_one_read(self):
        self.assertEqual(self.solve(["AB1"]), 0)

    def test_one_plate_many_times_counts_once(self):
        self.assertEqual(self.solve(["AB1"] * 2), 1)
        self.assertEqual(self.solve(["AB1"] * 7), 1)

    def test_every_plate_twice(self):
        self.assertEqual(self.solve(["A", "B", "C", "A", "B", "C"]), 3)

    def test_repeats_far_apart(self):
        plates = ["AB1"] + ["X" + str(n) for n in range(50)] + ["AB1"]
        self.assertEqual(self.solve(plates), 1)

    def test_plates_are_exact_text(self):
        # Different plates, however similar they look.
        self.assertEqual(self.solve(["AB1", "AB10", "AB1"]), 1)
        self.assertEqual(self.solve(["A", "AA", "AAA"]), 0)

    def test_longest_allowed_plate(self):
        long_plate = "AB123456"
        self.assertEqual(self.solve([long_plate, long_plate]), 1)

    def test_the_input_list_comes_back_untouched(self):
        plates = ["AB1", "CD2", "AB1"]
        self.solve(plates)
        self.assertEqual(
            plates, ["AB1", "CD2", "AB1"], msg="the list you were given was changed"
        )


if __name__ == "__main__":
    unittest.main()
