"""ch03 perf tier: 500k paths, duplicate at the very end.

Adversarial layout: every prefix is unique, so an O(n^2) list-scan pays its
full quadratic price (~1.25e11 character-comparisons' worth of work) and
blows the time limit. The O(n) set solution finishes in well under a second.
"""

import unittest

from bookgrader import load_solution

N = 500_000


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.first_duplicate = load_solution("dedup").first_duplicate

    def test_duplicate_at_the_end(self):
        paths = [f"compass/assets/story-{i:07d}.jpg" for i in range(N)]
        paths.append("compass/assets/story-0000000.jpg")
        self.assertEqual(
            self.first_duplicate(paths), "compass/assets/story-0000000.jpg"
        )

    def test_no_duplicate_at_scale(self):
        paths = [f"sideboard/cards/{i:07d}.json" for i in range(N)]
        self.assertIsNone(self.first_duplicate(paths))


if __name__ == "__main__":
    unittest.main()
