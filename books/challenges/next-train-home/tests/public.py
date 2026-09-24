"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("timetable").next_departure

    def test_statement_samples(self):
        self.assertEqual(self.solve([612, 645, 700, 733], 645), 645)
        self.assertEqual(self.solve([612, 645, 700, 733], 650), 700)
        self.assertEqual(self.solve([612, 645, 700, 733], 800), -1)
        self.assertEqual(self.solve([700, 700, 700], 699), 700)
        self.assertEqual(self.solve([], 500), -1)


if __name__ == "__main__":
    unittest.main()
