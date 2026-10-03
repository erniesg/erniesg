+++
id = "change-owed"
kind = "challenge"
title = "The machine that must not guess"
module = "change"
figure = "reading-a-traceback"
support = "guided"
difficulty = 2

requires = ["ch08-errors"]
teaches = ["errors-and-tracebacks"]
tags = ["part-1", "errors", "raising"]

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 10
timeout = 30

[tiers.edge]
xp = 15
timeout = 30

[tiers.stress]
xp = 20
timeout = 60

[tiers.perf]
xp = 5
timeout = 5
+++

:::statement
A ticket machine works out change. You give it a price and the amount the
customer put in, both in cents, and it tells you how much change to give.

Three kinds of input have no answer. For each, raise an error instead of
returning a number.

- An amount that is not a whole number, such as `"250"` from a keypad or `2.5`
  from a division, is the wrong **kind** of value. Raise `TypeError`.
- A negative amount is the right kind but an impossible **value**. Raise
  `ValueError`.
- Paying less than the price is also an impossible value: there is no change
  to give. Raise `ValueError`.

Every error you raise must carry a message.
:::

:::io
input: `price_cents` and `paid_cents`, both meant to be whole numbers
output: the change in cents, as a whole number — or a raised error
:::

:::constraints
- A valid `price_cents` or `paid_cents` is a whole number from 0 to 1,000,000.
- Check the kind before the value. `"250" < 0` raises its own error, not the
  one you meant.
- Do not catch anything here. This function's job is to raise.
:::

:::sample
| price_cents | paid_cents | Result | Why |
|---|---|---|---|
| `250` | `500` | `250` | ordinary change |
| `250` | `250` | `0` | exact money is fine |
| `0` | `0` | `0` | free, and nothing paid |
| `250` | `200` | `ValueError` | underpaid |
| `250` | `-5` | `ValueError` | impossible amount |
| `2.5` | `5.0` | `TypeError` | not whole numbers |
| `"250"` | `500` | `TypeError` | text, not a number |
:::

:::figure{id="reading-a-traceback"}
The message you write here is the last line of the traceback someone else
reads.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Three checks, then one subtraction. Most of the work is getting the checks in
the right order.
:::

:::hint{level=2}
`isinstance(value, int)` is `True` for `7` and `False` for `7.0` and `"7"`.
Check both arguments before you compare anything to zero.
:::

:::hint{level=3}
An f-string puts the bad value into the message:
`raise ValueError(f"paid {paid_cents} is less than the price {price_cents}")`.
:::

:::solution
```python
def change_owed(price_cents, paid_cents):
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
```

**Kind before value.** `isinstance` runs first because the later lines
compare the arguments to numbers. Swap the order and `change_owed("250",
500)` raises `TypeError: '<' not supported between instances of 'str' and
'int'`. That is still a `TypeError`, but it is Python's. It points at your
comparison, not at the caller who passed text. The test for `"250"` would
still pass, but the message would not help anyone.

**Why `2.5` is a `TypeError` and `-5` is a `ValueError`.** `2.5` is not the
kind of thing cents are. `-5` is a whole number of cents, just not a possible
one. Python itself splits errors this way. Following it means a caller who
writes `except ValueError` catches the cases they can fix.

**Why not return 0 when underpaid.** `0` already means "exact money, no
change", so the caller could not tell the two cases apart. The
public tier checks that `250, 250` gives `0` and that `250, 200` raises.

**The message.** `f"paid {paid_cents} is less than the price {price_cents}"`
puts both numbers in the last line of the traceback. `raise ValueError()` with
no message is legal, but it tells the reader nothing.
:::
