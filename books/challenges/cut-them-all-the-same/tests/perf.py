"""Perf tier: a year of ends, and an order for 150,000 leads.

Halving the range of lengths asks "how many leads at this length?" about
fifteen times, so the answer lands in under a tenth of a second. Trying every
length from 1 mm upwards asks it 8,325 times — one pass over 200,000 pieces
each time, 1.7 billion steps, forty seconds measured. The tier stops it at
three.

Nothing here is hard-coded: whatever comes back is checked against the two
things that make it the answer — that it fills the order, and that one
millimetre more would not.
"""

import random
import time
import unittest

from bookgrader import load_solution

SIZE = 200_000
WANTED = 150_000
TIME_LIMIT_SECONDS = 3.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("cable").longest_lead

    def test_a_year_of_ends(self):
        rng = random.Random(4242)
        pieces = [rng.randint(1, 20_000) for _ in range(SIZE)]

        started = time.perf_counter()
        answer = self.solve(pieces, WANTED)
        elapsed = time.perf_counter() - started

        self.assertGreater(answer, 0, msg="this order can be filled")
        self.assertGreaterEqual(
            sum(piece // answer for piece in pieces),
            WANTED,
            msg=f"{answer} mm leaves the order short",
        )
        self.assertLess(
            sum(piece // (answer + 1) for piece in pieces),
            WANTED,
            msg=f"{answer + 1} mm would have filled it too, so {answer} is not the longest",
        )
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s — "
            f"trying every length cannot pass here",
        )


if __name__ == "__main__":
    unittest.main()
