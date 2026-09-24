"""Reference solution: check the kind, then the value, then subtract."""


def change_owed(price_cents: int, paid_cents: int) -> int:
    for name, value in (("price_cents", price_cents), ("paid_cents", paid_cents)):
        if not isinstance(value, int):
            raise TypeError(f"{name} must be a whole number, got {value!r}")
    if price_cents < 0 or paid_cents < 0:
        raise ValueError(
            f"amounts cannot be negative: price {price_cents}, paid {paid_cents}"
        )
    if paid_cents < price_cents:
        raise ValueError(f"paid {paid_cents} is less than the price {price_cents}")
    return paid_cents - price_cents
