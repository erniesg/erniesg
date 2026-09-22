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

The point is the crossing between kinds. `"4" * 3` is legal Python and gives
you `"444"`, which is not what the customer owes.
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

**Walk it through.** `int(price_text)` crosses from text to number: the three
characters `"25"` become the value `25`. Now `*` means multiply rather than
repeat, and `25 * 4` is `100`.

Leave out the `int` and the tests fail loudly rather than quietly: `"25" * 4`
returns `"25252525"`, which is text, and the public tier compares it against
`100` and finds them different. That is the whole lesson — the operator did
exactly what it was told, for the kind of value it was given.

**Zero is worth a look.** `"0"` becomes `0`, and anything times zero is zero,
so both zero cases fall out without special handling. Code that needs an `if`
for zero here is usually code that forgot to convert.
:::
