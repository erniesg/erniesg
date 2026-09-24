"""Stress tier: against a referee that scans for the `=` by hand, and a round trip.

The referee never calls `split`. It looks at the characters one at a time to
find the first `=`, which is the rule the statement states, written out the
long way.
"""

import itertools
import random
import unittest

from bookgrader import load_solution


def slow_parse(line):
    """Obviously correct: strip, rule out, then find the first `=` character."""
    text = line.strip()
    if text == "":
        return None
    if text[0] == "#":
        return None
    cut = -1
    for index in range(len(text)):
        if text[index] == "=":
            cut = index
            break
    if cut == -1:
        return None
    key = text[:cut].strip().lower()
    if key == "":
        return None
    return (key, text[cut + 1 :].strip())


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("setting").parse_setting

    def test_every_short_line_exhaustively(self):
        for length in range(0, 5):
            for combo in itertools.product("a=# ", repeat=length):
                line = "".join(combo)
                self.assertEqual(
                    self.solve(line),
                    slow_parse(line),
                    msg=f"failed on {line!r}",
                )

    def test_random_lines_against_the_referee(self):
        rng = random.Random(20260920)
        alphabet = "aB1 =#\t/."
        for _ in range(1500):
            line = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 24)))
            self.assertEqual(self.solve(line), slow_parse(line), msg=f"failed on {line!r}")

    def test_a_written_setting_reads_back_the_same(self):
        rng = random.Random(4242)
        keys = ["keep", "PATH", "Max Retries", "disk", "q"]
        values = ["30", "/usr/bin", "a = b", "", "#ff0000", "hello   world", "x=1&y=2"]
        pad = ["", " ", "  ", "\t"]
        for _ in range(1000):
            key = rng.choice(keys)
            value = rng.choice(values)
            line = (
                rng.choice(pad) + key + rng.choice(pad) + "=" + rng.choice(pad) + value
            ).rstrip() + rng.choice(pad)
            self.assertEqual(
                self.solve(line),
                (key.strip().lower(), value.strip()),
                msg=f"failed on {line!r}",
            )


if __name__ == "__main__":
    unittest.main()
