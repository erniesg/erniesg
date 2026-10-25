+++
id = "overdraft-fees"
kind = "challenge"
title = "What the dips cost"
module = "overdraft"
figure = "running-balance"
support = "guided"
difficulty = 1

requires = ["ch04-loops"]
teaches = ["loops"]
tags = ["part-1", "loops", "running-total"]

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
An account starts the month with some number of cents, and a list of payments
goes out of it in order. After each payment, if the balance is below zero, the
bank charges 800 cents. It charges on every payment that leaves the balance
below zero, not once a month. The charge is recorded but not taken out of the
account, so it does not change the balance.

Return two numbers: the total charged, and the lowest the balance ever reached.

The starting balance counts as a balance the account reached. With no
payments, the lowest is the starting balance.
:::

:::io
input: `start`, a whole number of cents, and `payments`, a list of whole numbers of cents
output: a pair — total cents charged, and the lowest balance reached
:::

:::constraints
- `0 <= start <= 1,000,000`
- `payments` holds between 0 and 100,000 numbers.
- `0 <= payments[i] <= 1,000,000`
- A balance of exactly zero is not below zero, so it is not charged.
:::

:::sample
| start | payments | Output | Why |
|---|---|---|---|
| `12000` | `[4500, 3000, 2800, 4000, 1900]` | `(1600, -4200)` | the last two payments each end below zero |
| `1000` | `[1000]` | `(0, 0)` | exactly zero is not below zero |
| `500` | `[]` | `(0, 500)` | nothing goes out, so the start is the lowest |
| `100` | `[50, 50, 50]` | `(800, -50)` | one dip, charged once |
:::

:::figure{id="running-balance"}
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
One pass through the list. Keep three names outside the loop: the running
balance, the lowest so far, and the total charged.
:::

:::hint{level=2}
`lowest` has to start at a balance that really happened, and `start` is one.
If it starts at 0, an account that never went below 100 would report a low
of 0.
:::

:::hint{level=3}
Both checks happen *after* the subtraction, on the new balance. If all three
names are set before the loop, the empty list needs no special case. The loop
just does not run.
:::

:::solution
```python
def overdraft_cost(start, payments):
    balance = start
    lowest = start
    charged = 0
    for payment in payments:
        balance = balance - payment
        if balance < lowest:
            lowest = balance
        if balance < 0:
            charged = charged + 800
    return (charged, lowest)
```

**One pass, three names.** Each time round, the loop updates the balance and
asks two questions about it. Neither looks back at earlier payments, so
nothing has to be stored. Each payment costs the same whether there are five
or 100,000.

**Why `lowest` starts at `start`.** The statement says the starting balance
counts. Without it, an empty list would have no answer, because no payment
happened. Setting both `balance` and `lowest` to `start` before the loop
handles the empty case with no `if len(payments) == 0`.

**Two separate ifs, not `elif`.** A payment can set a new low and also leave
the balance below zero, and it usually does. With `elif`, the first sample
returns `(0, -4200)`. Every payment set a new low, so the charge branch never
ran. Two questions about the same value need two `if` statements.

**The slow version.** Working out the balance after payment `i` as
`start - sum(payments[:i])` is correct and reads well. But it adds up a longer
slice each time round: about five billion additions at 100,000 payments. The
perf tier is one call at the size limit, and this version fails it. A running total is the fix, and it is what the chapter teaches.
:::
