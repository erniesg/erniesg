"""Perf tier: a year of departures, asked 20,000 times.

Halving answers one question in 19 looks, so the whole batch is a few
hundredths of a second. Walking the timetable costs about half of it per
question: 20,000 questions against 400,000 departures is 4 billion steps, and
it measures at well over half a minute. The tier stops it at three seconds.
"""

import bisect
import random
import time
import unittest

from bookgrader import load_solution

SIZE = 400_000
QUESTIONS = 20_000
TIME_LIMIT_SECONDS = 3.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("timetable").next_departure

    def test_a_year_of_departures(self):
        rng = random.Random(4242)
        departures = sorted(rng.randint(0, 525_600) for _ in range(SIZE))
        arrivals = [rng.randint(0, 525_600) for _ in range(QUESTIONS)]
        # Plus the two that fall off the ends, which no random draw guarantees.
        arrivals.append(departures[-1] + 1)
        arrivals.append(0)

        started = time.perf_counter()
        answers = [self.solve(departures, arrival) for arrival in arrivals]
        elapsed = time.perf_counter() - started

        for arrival, answer in zip(arrivals, answers):
            where = bisect.bisect_left(departures, arrival)
            expected = departures[where] if where < SIZE else -1
            self.assertEqual(answer, expected, msg=f"wrong answer arriving at {arrival}")

        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s for {len(arrivals):,} questions, limit is "
            f"{TIME_LIMIT_SECONDS}s — walking the timetable cannot pass here",
        )


if __name__ == "__main__":
    unittest.main()
