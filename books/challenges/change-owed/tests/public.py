"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("change").change_owed

    def test_change_comes_back(self):
        self.assertEqual(self.solve(250, 500), 250)
        self.assertEqual(self.solve(250, 250), 0)
        self.assertEqual(self.solve(0, 0), 0)

    def test_underpaid_raises_value_error(self):
        with self.assertRaises(ValueError):
            self.solve(250, 200)

    def test_negative_raises_value_error(self):
        with self.assertRaises(ValueError):
            self.solve(250, -5)

    def test_wrong_kind_raises_type_error(self):
        with self.assertRaises(TypeError):
            self.solve(2.5, 5.0)
        with self.assertRaises(TypeError):
            self.solve("250", 500)


if __name__ == "__main__":
    unittest.main()
