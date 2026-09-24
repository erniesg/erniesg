"""Reference solution: guard, then floor division and remainder."""


def split_bill(cents: int, people: int) -> tuple[int, int]:
    if people == 0:
        return (0, 0)
    return (cents // people, cents % people)
