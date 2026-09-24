"""Edge tier: the empty pile, orders that cannot be filled, and the scrap."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("cable").longest_lead

    def test_nothing_on_the_pile(self):
        self.assertEqual(self.solve([], 1), 0)
        self.assertEqual(self.solve([], 1_000_000), 0)

    def test_order_cannot_be_filled(self):
        # 2,300 mm of cable, cut as finely as the rules allow, is 2,300 leads.
        self.assertEqual(self.solve([900, 1400], 2301), 0)
        self.assertEqual(self.solve([1], 2), 0)

    def test_one_piece(self):
        self.assertEqual(self.solve([10], 1), 10)
        self.assertEqual(self.solve([10], 2), 5)
        self.assertEqual(self.solve([10], 3), 3, msg="3 + 3 + 3 and 1 mm of scrap")
        self.assertEqual(self.solve([10], 10), 1)
        self.assertEqual(self.solve([10], 11), 0)

    def test_the_whole_piece_when_one_lead_is_wanted(self):
        self.assertEqual(self.solve([20_000], 1), 20_000)
        self.assertEqual(self.solve([7, 20_000, 19], 1), 20_000)

    def test_scrap_is_worth_nothing(self):
        # Two 5 mm pieces hold 10 mm of cable but cannot make one 7 mm lead.
        self.assertEqual(self.solve([5, 5], 1), 5)
        # And the average across pieces is not the answer: 4300 // 4 is 1075.
        self.assertEqual(self.solve([900, 2000, 1400], 4), 900)

    def test_one_long_piece_carries_the_order(self):
        self.assertEqual(self.solve([1, 1, 9000], 3), 3000)

    def test_identical_pieces(self):
        self.assertEqual(self.solve([20_000, 20_000, 20_000], 3), 20_000)
        self.assertEqual(self.solve([20_000, 20_000, 20_000], 4), 10_000)
        self.assertEqual(self.solve([1] * 5, 5), 1)
        self.assertEqual(self.solve([1] * 5, 6), 0)

    def test_the_answer_is_the_largest_one_that_works(self):
        pieces = [900, 2000, 1400]
        for wanted in range(1, 30):
            answer = self.solve(list(pieces), wanted)
            if answer == 0:
                continue
            self.assertGreaterEqual(
                sum(piece // answer for piece in pieces),
                wanted,
                msg=f"{answer} mm does not fill an order of {wanted}",
            )
            self.assertLess(
                sum(piece // (answer + 1) for piece in pieces),
                wanted,
                msg=f"{answer + 1} mm would also have filled an order of {wanted}",
            )

    def test_the_pile_comes_back_untouched(self):
        pieces = [900, 2000, 1400]
        self.solve(pieces, 4)
        self.assertEqual(pieces, [900, 2000, 1400], msg="the list you were given was changed")


if __name__ == "__main__":
    unittest.main()
