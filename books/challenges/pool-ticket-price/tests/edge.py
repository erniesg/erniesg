"""Edge tier: both ends of the range, and every line where one band meets the next."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("ticket").ticket_price

    def test_youngest_and_oldest(self):
        self.assertEqual(self.solve(0), 0)
        self.assertEqual(self.solve(120), 400)

    def test_each_boundary_pair(self):
        for younger, older, cheaper, dearer in [(4, 5, 0, 350), (17, 18, 350, 620)]:
            self.assertEqual(self.solve(younger), cheaper, msg=f"age {younger}")
            self.assertEqual(self.solve(older), dearer, msg=f"age {older}")
        self.assertEqual(self.solve(64), 620, msg="64 is still full price")
        self.assertEqual(self.solve(65), 400, msg="the cheaper price starts AT 65")

    def test_nothing_falls_off_the_bottom(self):
        for age in range(0, 121):
            price = self.solve(age)
            self.assertIsNotNone(price, msg=f"age {age} matched no band")
            self.assertIsInstance(price, int, msg=f"age {age} gave {price!r}")

    def test_only_the_four_prices_exist(self):
        prices = {self.solve(age) for age in range(0, 121)}
        self.assertEqual(prices, {0, 350, 620, 400})


if __name__ == "__main__":
    unittest.main()
