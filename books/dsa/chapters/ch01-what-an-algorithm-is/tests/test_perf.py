"""ch01 perf tier: million-digit additions inside the time limit.

Even addition has a cost: arbitrary-precision `+` is linear in the number of
digits. A sane implementation finishes far inside the limit; something that
converts through strings repeatedly, or loops digit by digit in Python,
will not.
"""

import unittest

from bookgrader import load_solution

DIGITS = 1_000_000


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.add = load_solution("warmup").add

    def test_million_digit_additions(self):
        a = 10**DIGITS - 1
        b = 10**DIGITS - 3
        for _ in range(5):
            self.assertEqual(self.add(a, b), a + b)
        self.assertEqual(self.add(a, -b), 2)


if __name__ == "__main__":
    unittest.main()
