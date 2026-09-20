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

Three things can arrive that have no answer, and the machine must say so
rather than invent a number.

- An amount that is not a whole number — `"250"` off a keypad, or `2.5` from a
  division — is the wrong **kind** of value. Raise `TypeError`.
- A negative amount is the right kind and an impossible **value**. Raise
  `ValueError`.
- Paying less than the price is also an impossible value: there is no change
  to give. Raise `ValueError`.

Every error you raise must carry a message. An error with nothing in it is
barely better than no error at all.
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

**Kind before value.** `isinstance` runs first because every later line assumes
it can compare the arguments to numbers. Swap the order and `change_owed("250",
500)` raises `TypeError: '<' not supported between instances of 'str' and
'int'` — still a `TypeError`, but Python's, pointing at your comparison instead
of at the caller who passed text. The tests would pass and the message would be
useless.

**Why `2.5` is a `TypeError` and `-5` is a `ValueError`.** `2.5` is not the
kind of thing cents are; no amount of arithmetic makes it one. `-5` *is* a
whole number of cents, it is just not a possible one. That split is the
convention the whole language follows, and following it means a caller who
writes `except ValueError` catches the cases they can fix.

**Why not return 0 when underpaid.** Because `0` is a real answer. It means
"exact money, nothing to hand back", and the machine would be unable to tell
the two apart. The edge tier checks `250, 250` gives `0` and `250, 200`
raises, which is the same check written twice on purpose.

**The message.** `f"paid {paid_cents} is less than the price {price_cents}"`
puts both numbers in the traceback's last line. `raise ValueError()` with no
message is legal and tells whoever reads the log nothing at all.
:::
