+++
id = "shop-total"
kind = "challenge"
title = "What the shop owes you"
module = "shop"
figure = "three-kinds"
support = "worked"
difficulty = 0

requires = ["ch01-values"]
teaches = ["values-and-variables"]
tags = ["part-1", "types"]

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 5
timeout = 30

[tiers.edge]
xp = 5
timeout = 30

[tiers.stress]
xp = 10
timeout = 60

[tiers.perf]
xp = 5
timeout = 5
+++

:::statement
A till reads prices off labels, so every price arrives as text: `"4"`, not `4`.
Given a price as text and a quantity as a whole number, work out the total as a
number.

The task is converting between kinds of value. `"4" * 3` is valid Python, but
it gives `"444"`, not what the customer owes.
:::

:::io
input: `price_text`, the price as text, and `quantity`, a whole number
output: the total as a whole number
:::

:::constraints
- `price_text` is text holding a whole number between 0 and 1,000.
- `quantity` is a whole number between 0 and 1,000.
:::

:::sample
| price_text | quantity | Output |
|---|---|---|
| `"4"` | `3` | `12` |
| `"0"` | `7` | `0` |
| `"25"` | `0` | `0` |
:::

:::figure{id="three-kinds"}
Text that looks like a number is still text until you convert it.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
`"4"` is text. Multiplying text by a number repeats it. Convert first.
:::

:::hint{level=2}
`int(price_text)` gives you the number `4` from the text `"4"`. Multiply that
by the quantity.
:::

:::solution
```python
def shop_total(price_text, quantity):
    return int(price_text) * quantity
```

**Walk it through.** `int(price_text)` converts text to a number: the text
`"25"` becomes the value `25`. Now `*` multiplies instead of repeating, and
`25 * 4` is `100`.

Without the `int`, `"25" * 4` returns the text `"25252525"`. The edge tier
expects `100`, so the test fails. `*` did what it does for the kind of value it
was given.

**Zero is worth a look.** `"0"` becomes `0`, and anything times zero is zero.
So both zero cases work without an `if`.
:::
