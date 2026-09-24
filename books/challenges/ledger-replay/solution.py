"""Reference solution: ask what would happen before letting it happen."""


def replay(amounts: list[int]) -> tuple[int, list[int]]:
    balance = 0
    rejected: list[int] = []
    for position, amount in enumerate(amounts):
        if amount < 0 and balance + amount < 0:
            rejected.append(position)
            continue
        balance += amount
    return (balance, rejected)
