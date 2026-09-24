"""Stress tier: every short title there is, against a character-by-character referee.

The referee walks the title one character at a time and writes the slug out by
hand. It is slow and it knows nothing about `split`, which is what makes it a
fair judge of code that does.
"""

import itertools
import random
import unittest

from bookgrader import load_solution

ALPHABET = "aB7 "


def slow_slug(title):
    """Obviously correct: copy characters across, turning gaps into one hyphen."""
    out = ""
    for char in title:
        if char == " ":
            if out and not out.endswith("-"):
                out += "-"
        else:
            out += char.lower()
    if out.endswith("-"):
        out = out[:-1]
    return out


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("slug").title_to_slug

    def test_every_title_up_to_five_characters(self):
        for length in range(0, 6):
            for combo in itertools.product(ALPHABET, repeat=length):
                title = "".join(combo)
                self.assertEqual(
                    self.solve(title),
                    slow_slug(title),
                    msg=f"failed on {title!r}",
                )

    def test_random_longer_titles(self):
        rng = random.Random(20260920)
        letters = "abcXYZ019 "
        for _ in range(600):
            title = "".join(rng.choice(letters) for _ in range(rng.randint(0, 60)))
            self.assertEqual(self.solve(title), slow_slug(title), msg=f"failed on {title!r}")

    def test_titles_made_of_real_words_with_ragged_spacing(self):
        rng = random.Random(11)
        words = ["Reading", "the", "Deal", "Two", "Pointers", "7", "Heaps"]
        for _ in range(300):
            picked = [rng.choice(words) for _ in range(rng.randint(0, 6))]
            gaps = [" " * rng.randint(1, 4) for _ in picked]
            title = " " * rng.randint(0, 3) + "".join(w + g for w, g in zip(picked, gaps))
            self.assertEqual(self.solve(title), slow_slug(title), msg=f"failed on {title!r}")


if __name__ == "__main__":
    unittest.main()
