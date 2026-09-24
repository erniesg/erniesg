"""The :::exercise block: parsing, both render targets, and the validator.

    python3 -m unittest discover -s books/tools -p 'test_*.py'
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import render
import validate

GOOD = '''Print the biggest.

```python
values = [3, 9, 4]
print(...)
```

```output
9
```

```answer
values = [3, 9, 4]
print(max(values))
```
'''


def block(inner: str, exercise_id: str = "biggest") -> str:
    return f':::exercise{{id="{exercise_id}"}}\n{inner}:::\n'


def drop(fence: str) -> str:
    return re.sub(rf"```{fence}\n.*?```\n", "", GOOD, flags=re.DOTALL)


def problems_for(body: str) -> list[str]:
    validate.problems.clear()
    validate.check_exercises(validate.BOOKS / "fixture.md", body)
    return list(validate.problems)


class ExerciseTests(unittest.TestCase):
    def test_parses_all_four_parts(self):
        parts = render.parse_exercise(GOOD)
        self.assertEqual(set(parts), set(render.EXERCISE_PARTS))

    def test_web_has_an_editor_and_hides_the_answer(self):
        html = render.exercise("biggest", GOOD, "web")
        self.assertIn('<textarea class="editor small"', html)
        self.assertIn('data-expected="9\n"', html)
        self.assertIn("<details class='answer'>", html)

    def test_print_shows_prompt_starter_and_answer_without_an_editor(self):
        html = render.exercise("biggest", GOOD, "print")
        self.assertNotIn("<textarea", html)
        self.assertNotIn("<details", html)
        self.assertIn("print(max(values))", html)

    def test_validator_accepts_a_good_exercise(self):
        self.assertEqual(problems_for(block(GOOD)), [])

    def test_validator_names_each_missing_part(self):
        cases = {
            "prompt": GOOD.replace("Print the biggest.\n", ""),
            "starter": drop("python"),
            "output": drop("output"),
            "answer": drop("answer"),
        }
        for part, inner in cases.items():
            with self.subTest(part=part):
                found = problems_for(block(inner))
                self.assertTrue(any(f"missing {part}" in p for p in found), found)

    def test_validator_rejects_a_check_that_cannot_pass(self):
        found = problems_for(block(GOOD.replace("```output\n9\n", "```output\n10\n")))
        self.assertTrue(any("the answer prints" in p for p in found), found)

    def test_validator_rejects_a_starter_that_is_already_done(self):
        found = problems_for(block(GOOD.replace("print(...)", "print(max(values))")))
        self.assertTrue(any("already prints" in p for p in found), found)

    def test_exercises_do_not_enter_the_counters(self):
        # Counters count nodes and challenges; an exercise is neither.
        before = len(render.all_nodes())
        self.assertNotIn("exercise", {n.get("kind") for n in render.all_nodes().values()})
        self.assertEqual(before, len(render.all_nodes()))

    def test_at_least_two_chapters_carry_exercises(self):
        chapters = sorted(validate.CHAPTERS.glob("ch*.md"))
        with_exercises = [c for c in chapters if ":::exercise" in c.read_text()]
        self.assertGreaterEqual(len(with_exercises), 2, [c.name for c in with_exercises])


if __name__ == "__main__":
    unittest.main()
