"""Reference solution: zip the two lists, sort on a tuple key, keep the names."""


def finishing_order(names: list[str], seconds: list[int]) -> list[str]:
    swimmers = sorted(zip(names, seconds), key=lambda pair: (pair[1], pair[0]))
    return [name for name, time_taken in swimmers]
