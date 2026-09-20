"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("setting").parse_setting

    def test_statement_samples(self):
        self.assertEqual(self.solve("name = Ada"), ("name", "Ada"))
        self.assertEqual(self.solve("  PATH=/usr/bin  "), ("path", "/usr/bin"))
        self.assertEqual(self.solve("greeting = a = b"), ("greeting", "a = b"))
        self.assertEqual(self.solve("retries ="), ("retries", ""))
        self.assertIsNone(self.solve("# retries = 3"))
        self.assertIsNone(self.solve("= 5"))


if __name__ == "__main__":
    unittest.main()
