"""Edge tier: exact money, the ends of the range, and the messages themselves."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("change").change_owed

    def test_exact_money_returns_zero_rather_than_raising(self):
        self.assertEqual(self.solve(1, 1), 0)
        self.assertEqual(self.solve(1_000_000, 1_000_000), 0)

    def test_one_cent_short_raises(self):
        with self.assertRaises(ValueError):
            self.solve(1_000_000, 999_999)

    def test_range_ends(self):
        self.assertEqual(self.solve(0, 1_000_000), 1_000_000)

    def test_answer_is_a_whole_number(self):
        self.assertIsInstance(self.solve(250, 500), int)

    def test_float_is_a_type_error_even_when_it_looks_whole(self):
        # 5.0 is worth the same as 5 and is still not a whole number.
        with self.assertRaises(TypeError):
            self.solve(250, 500.0)
        with self.assertRaises(TypeError):
            self.solve(250.0, 500)

    def test_kind_is_checked_before_the_value(self):
        # Text and a negative number at once: the kind complaint wins.
        with self.assertRaises(TypeError):
            self.solve("-250", -500)

    def test_negative_price_raises_even_when_paid_covers_it(self):
        with self.assertRaises(ValueError):
            self.solve(-250, 500)

    def test_every_error_carries_a_message(self):
        cases = [(250, 200), (250, -5), (-1, 0)]
        for price, paid in cases:
            with self.assertRaises(ValueError) as caught:
                self.solve(price, paid)
            self.assertTrue(
                str(caught.exception).strip(),
                msg=f"raised with an empty message on {price}, {paid}",
            )
        with self.assertRaises(TypeError) as caught:
            self.solve("250", 500)
        self.assertTrue(
            str(caught.exception).strip(), msg="TypeError raised with an empty message"
        )


if __name__ == "__main__":
    unittest.main()
