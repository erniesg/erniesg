"""Edge tier: the empty screen, the exact fit, and who owns the list that comes back."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("recent").recent

    def test_empty_screen_shows_nothing(self):
        self.assertEqual(
            self.solve([3, 8, 2, 9, 4], 0),
            [],
            msg="readings[-0:] is the whole log, not an empty screen",
        )
        self.assertEqual(self.solve([], 0), [])

    def test_exact_fit_and_one_over(self):
        self.assertEqual(self.solve([3, 8, 2], 3), [3, 8, 2])
        self.assertEqual(self.solve([3, 8, 2], 4), [3, 8, 2])
        self.assertEqual(self.solve([3, 8, 2], 1), [2])

    def test_biggest_screen(self):
        log = list(range(500))
        self.assertEqual(self.solve(log, 1000), log)
        self.assertEqual(self.solve(log, 1)[0], 499)

    def test_the_log_comes_back_untouched(self):
        log = [3, 8, 2, 9, 4]
        untouched = [3, 8, 2, 9, 4]
        for n in (0, 1, 5, 9):
            self.solve(log, n)
            self.assertEqual(log, untouched, msg=f"the log was changed by n={n}")

    def test_the_answer_is_a_list_of_its_own(self):
        log = [3, 8, 2]
        for n in (0, 3, 7):
            answer = self.solve(log, n)
            self.assertIsNot(answer, log, msg=f"n={n} handed back the caller's own list")
            answer.append(99)
            self.assertEqual(log, [3, 8, 2], msg=f"n={n} handed back a view of the log")


if __name__ == "__main__":
    unittest.main()
