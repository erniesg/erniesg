"""Reference solution: one pass, with zero as the stand-in for a new name."""


def tally_visits(names: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for name in names:
        counts[name] = counts.get(name, 0) + 1
    return counts
