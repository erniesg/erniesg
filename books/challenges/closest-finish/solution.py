"""Reference solution: sort the times, then walk neighbouring pairs."""


def closest_ascent(ascents: list[tuple[int, int]]) -> int:
    if len(ascents) < 2:
        return -1
    times = sorted(hundredths for _, hundredths in ascents)
    return min(later - earlier for earlier, later in zip(times, times[1:]))
