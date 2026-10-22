+++
id = "fridge-alarm"
kind = "challenge"
title = "The fridge that holds the medicine"
module = "fridge"
figure = "one-door-opens"
support = "guided"
difficulty = 1

requires = ["ch02-conditionals"]
teaches = ["conditionals"]
tags = ["part-1", "conditionals", "truthiness", "none"]

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
A village clinic keeps its vaccines in a fridge that must stay between 2 and 8
degrees. A small box on top of it reports three things every minute: the
temperature, how long the door has been open, and whether the mains is up.

The box shows one message. To pick it, ask these questions in this order and
use the first one that is true:

1. the temperature is `None`, meaning the sensor sent nothing: `"check the sensor"`
2. the power is off: `"power lost"`
3. the temperature is above 8: `"too warm"`
4. the temperature is below 2: `"too cold"`
5. the door has been open for 10 minutes or more: `"close the door"`
6. none of the above: `"ok"`

When more than one question is true, the first one in the list decides the
message.
:::

:::io
input: `celsius`, a number or `None`; `door_open_minutes`, a whole number; `power_ok`, `True` or `False`
output: one of the six messages above, as text
:::

:::constraints
- `celsius` is either `None` or a number between -30 and 40.
- `0 <= door_open_minutes <= 1440`
- `power_ok` is `True` or `False`.
- 2 and 8 are fine temperatures. 10 minutes counts as too long.
:::

:::sample
| celsius | door_open_minutes | power_ok | Output | Why |
|---|---|---|---|---|
| `5` | `0` | `True` | `"ok"` | cold enough, door shut, power up |
| `0.0` | `0` | `True` | `"too cold"` | zero is a reading, not a missing one |
| `None` | `0` | `True` | `"check the sensor"` | nothing to judge |
| `12` | `0` | `False` | `"power lost"` | power is asked before temperature |
| `5` | `25` | `True` | `"close the door"` | everything else is fine |
| `None` | `30` | `False` | `"check the sensor"` | question 1 wins, whatever else is wrong |
:::

:::figure{id="one-door-opens"}
Six questions in a fixed order; the first true one is the message.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Write one ladder with six rungs, in the order the statement lists them. Each
rung returns, so nothing below it can change the message.
:::

:::hint{level=2}
`if not celsius:` does not test for a missing reading. A fridge at `0.0`
degrees has sent a reading, but `0.0` is falsy. Ask whether the value *is*
`None`.
:::

:::hint{level=3}
Give the power question its own rung rather than folding it into the
temperature checks with `and`. At 12 degrees with the power off, only one
message comes out, and the statement says which.
:::

:::solution
```python
def fridge_message(celsius, door_open_minutes, power_ok):
    if celsius is None:
        return "check the sensor"
    elif not power_ok:
        return "power lost"
    elif celsius > 8:
        return "too warm"
    elif celsius < 2:
        return "too cold"
    elif door_open_minutes >= 10:
        return "close the door"
    else:
        return "ok"
```

**Why `is None` and not `not celsius`.** `None` means the sensor said nothing.
`0.0` means the sensor said zero. Both are falsy, so truthiness cannot tell
them apart. They need different actions: send an engineer, or move the
vaccines. `is` checks whether two values are the same object. A running
program has exactly one `None`, so `celsius is None` is true for the missing
reading and nothing else.

**Why that rung is first.** `None > 8` does not return `False`. It raises
`TypeError: '>' not supported between instances of 'NoneType' and 'int'`.
So the missing reading is handled before any comparison.

**Why one ladder and not separate ifs.** Every rung returns. At 12 degrees
with the power off, the function returns `"power lost"` and stops. With
separate ifs that each set a `message` variable, every if runs and the last
true one wins: `"too warm"`. That is true, but the power is what needs fixing.
:::
