"""Reference solution: one ladder, oldest band first."""


def ticket_price(age: int) -> int:
    if age >= 65:
        return 400
    elif age >= 18:
        return 620
    elif age >= 5:
        return 350
    else:
        return 0
