"""Edge tier: the ends of the list, exact matches, and repeated minutes."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("timetable").next_departure

    def test_empty_timetable(self):
        self.assertEqual(self.solve([], 0), -1)
        self.assertEqual(self.solve([], 525_600), -1)

    def test_one_departure(self):
        self.assertEqual(self.solve([480], 479), 480)
        self.assertEqual(self.solve([480], 480), 480, msg="she can still catch it")
        self.assertEqual(self.solve([480], 481), -1)

    def test_arriving_before_the_first_train(self):
        self.assertEqual(self.solve([612, 645, 700], 0), 612)

    def test_arriving_after_the_last_train(self):
        self.assertEqual(self.solve([612, 645, 700], 701), -1)
        self.assertEqual(self.solve([612, 645, 700], 525_600), -1)

    def test_the_exact_minute_counts(self):
        departures = [612, 645, 700, 733, 801]
        for time in departures:
            self.assertEqual(self.solve(departures, time), time, msg=f"missed the {time} train")

    def test_repeated_minutes_return_that_minute(self):
        self.assertEqual(self.solve([700, 700, 700], 700), 700)
        self.assertEqual(self.solve([700, 700, 700], 701), -1)
        self.assertEqual(self.solve([600, 700, 700, 700, 800], 650), 700)

    def test_ends_of_the_range(self):
        self.assertEqual(self.solve([0, 525_600], 0), 0)
        self.assertEqual(self.solve([0, 525_600], 1), 525_600)
        self.assertEqual(self.solve([0, 525_600], 525_600), 525_600)

    def test_every_gap_in_a_small_timetable(self):
        departures = [2, 4, 6, 8]
        expected = [2, 2, 2, 4, 4, 6, 6, 8, 8, -1, -1]
        for arrival, want in enumerate(expected):
            self.assertEqual(self.solve(departures, arrival), want, msg=f"arriving at {arrival}")

    def test_the_timetable_comes_back_untouched(self):
        departures = [612, 645, 700, 733]
        self.solve(departures, 650)
        self.assertEqual(departures, [612, 645, 700, 733], msg="the list you were given was changed")


if __name__ == "__main__":
    unittest.main()
