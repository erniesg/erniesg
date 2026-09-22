"""Stress tier: against a referee that reads each line one character at a time.

The reference never calls int(). It checks the characters by hand and builds
the number digit by digit, which is slow, dull, and obviously right.
"""

import random
import unittest

from bookgrader import load_solution

DIGITS = "0123456789"

TOKENS = [
    "0", "7", "42", "1200", "007", "  5  ", "", "   ", "\t",
    "twelve", "3.0", "-5", "-0", "12a", "a12", "1 2", "+9", " 100 ",
]


def reference(lines):
    """The same rules, spelled out the long way."""
    if not isinstance(lines, list):
        raise TypeError("lines must be a list of strings")

    total = 0
    problems = []
    for number, line in enumerate(lines, start=1):
        text = line.strip()
        if text == "":
            continue
        sign, body = "", text
        if text[0] in "+-":
            sign, body = text[0], text[1:]
        if body == "" or any(character not in DIGITS for character in body):
            problems.append((number, line))
            continue
        value = 0
        for character in body:  # build the number a digit at a time
            value = value * 10 + DIGITS.index(character)
        if sign == "-" and value != 0:
            problems.append((number, line))
            continue
        total += value
    return (total, problems)


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("rows").parse_amounts

    def test_every_short_file_of_these_tokens(self):
        # Exhaustive over every one- and two-line file the tokens can make.
        for first in TOKENS:
            self.assertEqual(
                self.solve([first]), reference([first]), msg=f"failed on {[first]!r}"
            )
            for second in TOKENS:
                lines = [first, second]
                self.assertEqual(
                    self.solve(lines), reference(lines), msg=f"failed on {lines!r}"
                )

    def test_random_files(self):
        rng = random.Random(20260920)
        for _ in range(500):
            how_many = rng.randint(0, 8)
            lines = [rng.choice(TOKENS) for _ in range(how_many)]
            self.assertEqual(
                self.solve(lines), reference(lines), msg=f"failed on {lines!r}"
            )

    def test_line_numbers_always_point_at_the_line_they_name(self):
        rng = random.Random(77)
        for _ in range(300):
            lines = [rng.choice(TOKENS) for _ in range(rng.randint(1, 10))]
            _, problems = self.solve(lines)
            for number, text in problems:
                self.assertEqual(
                    lines[number - 1],
                    text,
                    msg=f"line {number} is not {text!r} in {lines!r}",
                )


if __name__ == "__main__":
    unittest.main()
