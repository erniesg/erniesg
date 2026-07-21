"""ch03 stress tier: random inputs vs a brute-force referee."""

import random
import unittest

from bookgrader import load_solution

ROUNDS = 400


def referee(paths: list[str]) -> str | None:
    for i, path in enumerate(paths):
        if path in paths[:i]:
            return path
    return None


class StressTests(unittest.TestCase):
    def setUp(self):
        self.first_duplicate = load_solution("dedup").first_duplicate

    def test_random_rounds_against_referee(self):
        rng = random.Random(20260721)
        for round_no in range(ROUNDS):
            n = rng.randint(0, 50)
            # A small alphabet forces plenty of collisions.
            paths = [f"asset-{rng.randint(0, 15)}.png" for _ in range(n)]
            expected = referee(paths)
            got = self.first_duplicate(paths)
            self.assertEqual(
                got, expected,
                msg=(f"round {round_no}: disagreement on {paths!r} — "
                     f"got {got!r}, referee said {expected!r}"),
            )

    def test_unique_heavy_rounds(self):
        rng = random.Random(31337)
        for round_no in range(ROUNDS):
            n = rng.randint(0, 40)
            paths = [f"asset-{rng.randint(0, 10**9)}.png" for _ in range(n)]
            self.assertEqual(
                self.first_duplicate(paths), referee(paths),
                msg=f"unique-heavy round {round_no}: input {paths!r}",
            )


if __name__ == "__main__":
    unittest.main()
