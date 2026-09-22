"""Stress tier: against a plain walk, on timetables small enough to draw.

The referee below is the answer you were told not to write: read the timetable
from the start and stop at the first train that has not gone. On six
departures it costs nothing and it cannot be wrong. Minutes are drawn from a
small range so that repeats, single-train days and empty timetables all turn
up within a few tries.
"""

import random
import unittest

from bookgrader import load_solution


def walk_it(departures, arrival):
    for time in departures:
        if time >= arrival:
            return time
    return -1


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("timetable").next_departure

    def test_random_tiny_timetables(self):
        rng = random.Random(20260920)
        for _ in range(2000):
            departures = sorted(rng.randint(0, 8) for _ in range(rng.randint(0, 6)))
            arrival = rng.randint(0, 9)
            self.assertEqual(
                self.solve(list(departures), arrival),
                walk_it(departures, arrival),
                msg=f"wrong answer for {departures!r}, arriving at {arrival}",
            )

    def test_every_arrival_against_every_small_timetable(self):
        for size in range(0, 5):
            for pattern in range(2**size):
                departures = [
                    minute for minute in range(size) if pattern >> minute & 1
                ]
                for arrival in range(0, size + 2):
                    self.assertEqual(
                        self.solve(list(departures), arrival),
                        walk_it(departures, arrival),
                        msg=f"wrong answer for {departures!r}, arriving at {arrival}",
                    )

    def test_longer_random_timetables(self):
        rng = random.Random(4242)
        for _ in range(60):
            departures = sorted(rng.randint(0, 525_600) for _ in range(rng.randint(1, 300)))
            for _ in range(20):
                arrival = rng.randint(0, 525_600)
                self.assertEqual(
                    self.solve(list(departures), arrival),
                    walk_it(departures, arrival),
                    msg=f"wrong answer arriving at {arrival}",
                )


if __name__ == "__main__":
    unittest.main()
