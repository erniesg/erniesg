"""Public tier: the rows printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("fridge").fridge_message

    def test_statement_samples(self):
        self.assertEqual(self.solve(5, 0, True), "ok")
        self.assertEqual(self.solve(0.0, 0, True), "too cold")
        self.assertEqual(self.solve(None, 0, True), "check the sensor")
        self.assertEqual(self.solve(12, 0, False), "power lost")
        self.assertEqual(self.solve(5, 25, True), "close the door")
        self.assertEqual(self.solve(None, 30, False), "check the sensor")


if __name__ == "__main__":
    unittest.main()
