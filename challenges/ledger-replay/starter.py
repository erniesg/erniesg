"""The card that went below zero.

    python3 challenges/tools/grade.py run ledger-replay

This one is already written, and it is already wrong. Run the tests, then make
the loop say what the balance is after every entry.
"""


def replay(amounts: list[int]) -> tuple[int, list[int]]:
    balance = 0
    rejected = []
    for position, amount in enumerate(amounts):
        balance += amount
        if balance < 0:
            rejected.append(position)
    return (balance, rejected)
