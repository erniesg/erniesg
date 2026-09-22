"""Stress tier: every combination that matters, against a plodding referee.

The referee keeps the six questions in a list, in order, and walks it. It is
slower and duller than any real answer, which is the point: there is nowhere
in it for a subtle mistake to hide.
"""

import itertools
import random
import unittest

from bookgrader import load_solution

TEMPERATURES = [None, -30, -0.5, 0, 0.0, 1.9, 2, 5, 8, 8.1, 40]
DOOR_MINUTES = [0, 1, 9, 10, 11, 1440]
POWER = [True, False]

MESSAGES = {
    "check the sensor",
    "power lost",
    "too warm",
    "too cold",
    "close the door",
    "ok",
}


def referee(celsius, door_open_minutes, power_ok):
    if celsius is None:
        return "check the sensor"
    questions = [
        (not power_ok, "power lost"),
        (celsius > 8, "too warm"),
        (celsius < 2, "too cold"),
        (door_open_minutes >= 10, "close the door"),
    ]
    for holds, message in questions:
        if holds:
            return message
    return "ok"


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("fridge").fridge_message

    def test_the_whole_grid(self):
        for celsius, door, power_ok in itertools.product(TEMPERATURES, DOOR_MINUTES, POWER):
            self.assertEqual(
                self.solve(celsius, door, power_ok),
                referee(celsius, door, power_ok),
                msg=f"failed on celsius={celsius!r}, door={door}, power_ok={power_ok}",
            )

    def test_random_readings(self):
        rng = random.Random(20260920)
        for _ in range(2000):
            celsius = None if rng.random() < 0.1 else rng.randrange(-300, 401) / 10
            door = rng.randint(0, 1440)
            power_ok = rng.random() < 0.8
            got = self.solve(celsius, door, power_ok)
            self.assertEqual(
                got,
                referee(celsius, door, power_ok),
                msg=f"failed on celsius={celsius!r}, door={door}, power_ok={power_ok}",
            )
            self.assertIn(
                got,
                MESSAGES,
                msg=f"{got!r} is not one of the six messages",
            )


if __name__ == "__main__":
    unittest.main()
