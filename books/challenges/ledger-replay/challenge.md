+++
id = "ledger-replay"
kind = "challenge"
title = "The card that went below zero"
module = "ledger"
figure = "stepping-a-loop"
support = "unaided"
difficulty = 4

requires = ["ch09-stepping"]
teaches = ["stepping-through-code"]
tags = ["part-1", "debugging", "state"]

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 15
timeout = 30

[tiers.edge]
xp = 20
timeout = 30

[tiers.stress]
xp = 25
timeout = 60

[tiers.perf]
xp = 10
timeout = 10
+++

:::statement
A prepaid travel card has no overdraft. Top-ups add to the balance. Fares take
from it — unless the fare would push the balance below zero, in which case the
gate refuses it, the balance does not move, and the refusal is logged.

Replay a day of activity and report two things: the balance at the end, and
the positions of the entries that were refused.

The starter is wrong: it can let the balance go below zero. Find the line that
allows this, then use the tests to confirm the required behaviour.
:::

:::io
input: `amounts`, a list of whole numbers — zero or more is a top-up, below zero is a fare
output: a pair — the final balance, and a list of the positions that were refused
:::

:::constraints
- `0 <= len(amounts) <= 200,000`.
- Each amount is a whole number between -1,000,000 and 1,000,000.
- Positions count from 0 and come back in the order they happened.
- A fare that takes the balance to exactly zero is allowed.
- A refused fare changes nothing. The entries after it see the balance it
  would have had if that entry had never arrived.
- The balance never goes below zero.
:::

:::sample
| amounts | Output | Why |
|---|---|---|
| `[500, -200, -400, 100]` | `(400, [2])` | 400 is more than the 300 left |
| `[200, -50, -300, -50]` | `(100, [2])` | the refusal does not stop the next fare |
| `[100, -100]` | `(0, [])` | exactly empty is fine |
| `[-50]` | `(0, [0])` | nothing on the card yet |
| `[]` | `(0, [])` | no activity |
:::

:::figure{id="stepping-a-loop"}
Print the balance after every entry to find where it becomes negative.
:::

:::run{starter="starter.py"}
:::

:::solution
```python
def replay(amounts):
    balance = 0
    rejected = []
    for position, amount in enumerate(amounts):
        if amount < 0 and balance + amount < 0:
            rejected.append(position)
            continue
        balance += amount
    return (balance, rejected)
```

**The starter changed the balance too early.** It added the amount before
checking the result. When it found a negative balance, the balance had already
changed.

`[500, -200, -400, 100]` shows it: 500, then 300, then -100 with position 2
logged, then 0. The right answer is 400, because the -400 never happened.

**Check before changing the balance.** `balance + amount < 0` checks the
result before adding the fare.

**Keep `amount < 0` in the condition.** A top-up cannot make the balance
negative. The check makes clear that the rule applies to fares.

**Finding it.** Print the position, amount and balance inside the loop. The
negative balance appears with the entry that caused it. You can also pause
before that line with `breakpoint()` and type `p balance, amount`.

**Keep a running balance.** Adding all accepted entries again for every entry
would take twenty billion additions for 200,000 entries. Update `balance`
once for each entry instead.
:::
