"""Edge tier: the default that remembers, and the caller's own list.

Everything here is about the two promises a sample cannot show: a call that
passes no log gets a log of its own, and a call that passes one gets it back.
"""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("shortfall").log_shortfalls

    def test_two_calls_with_no_log_do_not_share_one(self):
        first = self.solve([100])
        second = self.solve([50])
        self.assertEqual(first, [(0, 80)])
        self.assertEqual(
            second,
            [(0, 130)],
            msg="the second call is seeing the first call's entries: `log=[]` "
            "is built once, at the def line",
        )
        self.assertIsNot(first, second, msg="each call with no log needs its own list")

    def test_a_third_call_is_still_clean(self):
        self.solve([1, 2, 3])
        self.solve([4, 5, 6])
        self.assertEqual(self.solve([]), [])

    def test_the_caller_gets_their_own_list_back(self):
        given = []
        returned = self.solve([5], 10, given)
        self.assertIs(returned, given, msg="append to the list you were given")
        self.assertEqual(given, [(0, 5)])

    def test_an_empty_list_passed_in_is_not_nothing(self):
        # `if not log:` treats [] the same as no list at all, and the caller
        # never sees their entries.
        given = []
        self.solve([5], 10, given)
        self.assertEqual(given, [(0, 5)], msg="check `log is None`, not whether it is empty")

    def test_a_passed_log_survives_a_month_with_no_shortfalls(self):
        given = [(0, 4)]
        returned = self.solve([200, 300], 180, given)
        self.assertIs(returned, given)
        self.assertEqual(returned, [(0, 4)])

    def test_exactly_on_target_is_not_short(self):
        self.assertEqual(self.solve([180, 180, 180]), [])
        self.assertEqual(self.solve([9, 10, 11], 10), [(0, 1)])

    def test_every_night_short(self):
        self.assertEqual(self.solve([0, 0, 0], 3), [(0, 3), (1, 3), (2, 3)])

    def test_equal_nights_are_logged_at_their_own_positions(self):
        # `served.index(meals)` would log both of these against night 0.
        self.assertEqual(self.solve([5, 9, 5], 10), [(0, 5), (1, 1), (2, 5)])

    def test_range_ends(self):
        self.assertEqual(self.solve([0], 1_000_000), [(0, 1_000_000)])
        self.assertEqual(self.solve([1_000_000], 1), [])

    def test_entries_are_pairs_of_whole_numbers(self):
        entries = self.solve([150])
        self.assertIsInstance(entries, list)
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertIsInstance(entry, tuple, msg="log (night, shortfall) as a pair")
        self.assertEqual(len(entry), 2)
        self.assertIsInstance(entry[0], int)
        self.assertIsInstance(entry[1], int)


if __name__ == "__main__":
    unittest.main()
