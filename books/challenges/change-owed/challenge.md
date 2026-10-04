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
A ticket machine works out change: you give it a price and the amount the
customer put in, both in cents, and it tells you what to hand back.

Some inputs cannot produce change. Raise an error for each one.

- An amount that is not a whole number — `"250"` off a keypad, or `2.5` from a
  division — is the wrong **kind** of value. Raise `TypeError`.
- A negative amount is the right kind and an impossible **value**. Raise
  `ValueError`.
- Paying less than the price is also an impossible value: there is no change
  to give. Raise `ValueError`.

Include a message with every error so the caller can see what went wrong.
:::

:::io
input: `price_cents` and `paid_cents`, both meant to be whole numbers
output: the change in cents, as a whole number — or a raised error
:::

:::constraints
- A valid `price_cents` or `paid_cents` is a whole number from 0 to 1,000,000.
- Check the kind before the value: `"250" < 0` raises an error of its own, and
  it will not be the one you meant.
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
The message you write here is the last line someone else will read.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Three checks, then one subtraction. The order of the checks is the whole
problem.
:::

:::hint{level=2}
`isinstance(value, int)` is `True` for `7` and `False` for `7.0` and `"7"`.
Do both arguments before you compare anything to zero.
:::

:::hint{level=3}
An f-string puts the offending value into the message:
`raise ValueError(f"paid {paid_cents} is less than the price {price_cents}")`.
That number is what saves someone ten minutes later.
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

**Check the kind first.** Every later line compares the arguments to numbers.
If you swap the order, `change_owed("250", 500)` raises `TypeError: '<' not
supported between instances of 'str' and 'int'`. That message points to the
comparison instead of the text passed by the caller.

**`2.5` and `-5` fail for different reasons.** `2.5` is not a whole number.
`-5` is a whole number, but it is not a possible amount. This lets callers use
`except ValueError` for values they can correct.

**Do not return `0` when underpaid.** `0` already means the customer paid the
exact amount. Use an error to keep the two cases distinct.

**Include both amounts in the message.**
`f"paid {paid_cents} is less than the price {price_cents}"` shows the price
and payment in the traceback.
:::
