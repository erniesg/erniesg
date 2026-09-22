"""The streak that ran off the end.

    python3 books/tools/grade.py run longest-streak

This one is already written, and it is wrong. Run the tests, then put a print
inside the loop and watch `current` and `best` as the days go by.
"""


def longest_streak(days: list[bool]) -> int:
    best = 0
    current = 0
    for ran in days:
        if ran:
            current += 1
        else:
            best = max(best, current)
            current = 0
    return best
