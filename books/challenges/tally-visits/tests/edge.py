"""Edge tier: the empty log, the ends of the name range, and the shape of the answer."""

import unittest

from bookgrader import load_solution


def name_for(number: int) -> str:
    """A distinct name of lowercase letters, as the constraints promise."""
    letters = ""
    number += 1
    while number:
        number, rest = divmod(number - 1, 26)
        letters = chr(ord("a") + rest) + letters
    return letters


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("tally").tally_visits

    def test_empty_log_gives_empty_dict(self):
        result = self.solve([])
        self.assertIsInstance(result, dict, msg="return a dict even when nothing came in")
        self.assertEqual(result, {})

    def test_shortest_and_longest_names(self):
        short, long = "a", "q" * 20
        self.assertEqual(self.solve([short, long, short]), {short: 2, long: 1})

    def test_names_that_look_alike_stay_apart(self):
        self.assertEqual(self.solve(["ad", "ada", "ad"]), {"ad": 2, "ada": 1})

    def test_no_name_is_invented_and_none_is_lost(self):
        log = ["ada", "grace", "alan", "ada", "grace", "ada"]
        result = self.solve(log)
        self.assertEqual(set(result), {"ada", "grace", "alan"}, msg="keys are the names seen")
        self.assertEqual(sum(result.values()), len(log), msg="the counts must add up to the log")

    def test_counts_are_whole_numbers(self):
        result = self.solve(["ada", "ada"])
        self.assertIsInstance(result["ada"], int)
        self.assertEqual(result["ada"], 2)

    def test_many_distinct_names_each_once(self):
        log = [name_for(n) for n in range(500)]
        result = self.solve(log)
        self.assertEqual(len(result), 500)
        self.assertEqual(set(result.values()), {1})


if __name__ == "__main__":
    unittest.main()
