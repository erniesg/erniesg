"""Reference solution: whole trips by arithmetic, the remainder by one short walk."""


def days_of_credit(credit: int, usage: list[int]) -> int:
    cycle = sum(usage)
    if cycle == 0:
        return -1
    days = (credit // cycle) * len(usage)
    left = credit % cycle
    for amount in usage:
        if amount > left:
            break
        left = left - amount
        days = days + 1
    return days
