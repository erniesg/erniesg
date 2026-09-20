"""Reference solution: answer the empty screen, then take a tail slice."""


def recent(readings: list[int], n: int) -> list[int]:
    if n == 0:
        return []
    return readings[-n:]
