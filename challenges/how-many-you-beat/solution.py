"""Reference solution: counting sort, then a running total along the counts."""


def riders_you_beat(times: list[int]) -> list[int]:
    if not times:
        return []
    chalk = [0] * (max(times) + 1)
    for value in times:
        chalk[value] += 1

    faster = 0
    for value in range(len(chalk)):
        here = chalk[value]
        chalk[value] = faster
        faster += here

    return [chalk[value] for value in times]
