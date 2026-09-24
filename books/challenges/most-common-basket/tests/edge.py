"""Edge tier: empty baskets, ties, and the type of the answer."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("baskets").most_common_basket

    def test_nothing_scanned(self):
        self.assertEqual(self.solve([]), [])

    def test_an_empty_basket_is_a_basket(self):
        # Somebody scanned nothing and walked out. Twice.
        self.assertEqual(self.solve([[], ["milk"], []]), [])

    def test_order_inside_a_basket_matters(self):
        baskets = [["a", "b"], ["b", "a"], ["b", "a"]]
        self.assertEqual(self.solve(baskets), ["b", "a"])

    def test_tie_goes_to_the_first_one_seen(self):
        self.assertEqual(self.solve([["b"], ["a"], ["a"], ["b"]]), ["b"])
        self.assertEqual(self.solve([["a"], ["b"], ["b"], ["a"]]), ["a"])

    def test_every_basket_different(self):
        self.assertEqual(self.solve([["c"], ["a"], ["b"]]), ["c"])

    def test_full_size_basket(self):
        big = ["item" + str(n) for n in range(8)]
        self.assertEqual(self.solve([big, ["x"], list(big)]), big)

    def test_answer_is_a_list_not_a_tuple(self):
        answer = self.solve([["milk", "eggs"]])
        self.assertIsInstance(answer, list, msg="convert the frozen key back to a list")
        self.assertEqual(answer, ["milk", "eggs"])

    def test_the_log_comes_back_untouched(self):
        baskets = [["milk", "eggs"], ["eggs"], ["milk", "eggs"]]
        self.solve(baskets)
        self.assertEqual(baskets, [["milk", "eggs"], ["eggs"], ["milk", "eggs"]])

    def test_answer_does_not_alias_an_input_basket(self):
        # Changing the answer afterwards must not reach back into the log.
        baskets = [["milk"], ["milk"]]
        answer = self.solve(baskets)
        answer.append("stolen")
        self.assertEqual(baskets, [["milk"], ["milk"]])


if __name__ == "__main__":
    unittest.main()
