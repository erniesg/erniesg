"""Reference solution: bring `best` up to date the moment `current` moves."""


def longest_streak(days: list[bool]) -> int:
    best = 0
    current = 0
    for ran in days:
        if ran:
            current += 1
            if current > best:
                best = current
        else:
            current = 0
    return best
