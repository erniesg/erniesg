"""Reference solution: one pass, asking a set for the missing half."""


def first_balancing_line(amounts: list[int], target: int) -> int:
    seen: set[int] = set()
    for position, amount in enumerate(amounts):
        if target - amount in seen:
            return position
        seen.add(amount)
    return -1
