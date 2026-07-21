"""ch01 stress tier: randomized rounds against a brute-force reference.

The reference here is Python's own `+` — trivially correct. The point of
this tier in chapter 1 is to show you the *mechanism* you'll rely on for the
rest of the book: hundreds of random inputs, compared against something you
trust, with the failing seed printed so you can reproduce it.
"""

import random
import unittest

from bookgrader import load_solution

ROUNDS = 500


class StressTests(unittest.TestCase):
    def setUp(self):
        self.add = load_solution("warmup").add

    def test_random_rounds_against_reference(self):
        rng = random.Random(20260721)
        for round_no in range(ROUNDS):
            digits = rng.randint(1, 200)
            a = rng.randint(-(10**digits), 10**digits)
            b = rng.randint(-(10**digits), 10**digits)
            expected = a + b
            got = self.add(a, b)
            self.assertEqual(
                got, expected,
                msg=f"round {round_no}: add({a}, {b}) returned {got}, expected {expected}",
            )


if __name__ == "__main__":
    unittest.main()
