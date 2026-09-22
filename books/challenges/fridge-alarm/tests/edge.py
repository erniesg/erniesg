"""Edge tier: the two temperature lines, the door minute, and the falsy reading."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("fridge").fridge_message

    def test_the_fridge_may_sit_on_its_limits(self):
        self.assertEqual(self.solve(2, 0, True), "ok", msg="2 degrees is allowed")
        self.assertEqual(self.solve(8, 0, True), "ok", msg="8 degrees is allowed")
        self.assertEqual(self.solve(8.1, 0, True), "too warm")
        self.assertEqual(self.solve(1.9, 0, True), "too cold")

    def test_the_door_minute(self):
        self.assertEqual(self.solve(5, 9, True), "ok")
        self.assertEqual(self.solve(5, 10, True), "close the door")
        self.assertEqual(self.solve(5, 1440, True), "close the door")

    def test_zero_is_a_reading(self):
        self.assertEqual(
            self.solve(0, 0, True),
            "too cold",
            msg="0 is falsy, but the sensor did report it",
        )
        self.assertEqual(self.solve(0.0, 20, True), "too cold")

    def test_order_when_several_are_wrong(self):
        self.assertEqual(self.solve(None, 0, False), "check the sensor")
        self.assertEqual(self.solve(0.0, 0, False), "power lost")
        self.assertEqual(self.solve(40, 600, False), "power lost")
        self.assertEqual(self.solve(40, 600, True), "too warm")
        self.assertEqual(self.solve(-30, 600, True), "too cold")

    def test_ends_of_the_range(self):
        self.assertEqual(self.solve(-30, 0, True), "too cold")
        self.assertEqual(self.solve(40, 0, True), "too warm")


if __name__ == "__main__":
    unittest.main()
