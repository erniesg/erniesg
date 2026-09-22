"""Which line was wrong.

    python3 books/tools/grade.py run bad-row-report
"""


def parse_amounts(lines: list[str]) -> tuple[int, list[tuple[int, str]]]:
    # Not a list at all -> TypeError. Nothing else raises.
    # Walk the lines, counting from 1 and counting blanks.
    # Blank (or spaces only) -> skip. Not a whole number, or below zero ->
    # record (line_number, the line exactly as it arrived). Otherwise add it up.
    raise NotImplementedError("Write me")
