"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("rows").parse_amounts

    def test_statement_samples(self):
        self.assertEqual(
            self.solve(["1200", "850", "twelve", "3000"]), (5050, [(3, "twelve")])
        )
        self.assertEqual(self.solve(["  42  ", "", "   ", "7"]), (49, []))
        self.assertEqual(self.solve(["-5", "5"]), (5, [(1, "-5")]))
        self.assertEqual(self.solve([]), (0, []))

    def test_not_a_list_raises_type_error(self):
        with self.assertRaises(TypeError):
            self.solve(None)


if __name__ == "__main__":
    unittest.main()
