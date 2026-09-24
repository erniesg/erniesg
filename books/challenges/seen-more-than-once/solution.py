"""Reference solution: count every plate in one pass, then count the repeats."""


def count_repeat_visitors(plates: list[str]) -> int:
    seen: dict[str, int] = {}
    for plate in plates:
        seen[plate] = seen.get(plate, 0) + 1
    return sum(1 for count in seen.values() if count > 1)
