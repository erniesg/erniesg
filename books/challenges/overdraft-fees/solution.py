"""Reference solution: one pass, carrying a balance, a low-water mark and a total."""


def overdraft_cost(start: int, payments: list[int]) -> tuple[int, int]:
    balance = start
    lowest = start
    charged = 0
    for payment in payments:
        balance = balance - payment
        if balance < lowest:
            lowest = balance
        if balance < 0:
            charged = charged + 800
    return (charged, lowest)
