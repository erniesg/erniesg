"""The machine that must not guess.

    python3 challenges/tools/grade.py run change-owed
"""


def change_owed(price_cents: int, paid_cents: int) -> int:
    # Check the kind of both arguments first: not a whole number -> TypeError.
    # Then the values: negative, or paid less than the price -> ValueError.
    # Every raise needs a message with the offending number in it.
    raise NotImplementedError("Write me")
