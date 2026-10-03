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
from it. If a fare would push the balance below zero, the gate refuses it. The
balance does not change, and the refusal is logged.

Replay a day of activity and report two things: the balance at the end, and
the positions of the entries that were refused.

The starter is already written, and it is wrong: its balance can go below
zero. Find where that happens, and read the tests to see what should happen
instead.
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
- A refused fare changes nothing. The entries after it see the balance as if
  that entry had never arrived.
- The balance is never below zero at any point.
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
Print the balance on every entry, and the entry that takes it below zero stands out.
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

**What the bug was.** The starter added the amount first and then checked the
result. When it saw a negative balance, the balance was already negative, and
nothing put it back. It logged the refusal but did not refuse anything.

With `[500, -200, -400, 100]` the starter's balance goes 500, 300, -100 (with
position 2 logged), then 0. The right answer is 400, because the -400 is
refused.

**Check before changing the balance.** `balance + amount < 0` works out what
the balance would be without changing it. Rules like this one all work the
same way: test the change first, then make it.

**Why the `amount < 0` part is there.** A top-up can never take the balance
below zero, so the code passes without it. It is there for the reader: it says
the rule is about fares. Without it, the next person has to work out why
top-ups are never refused.

**Finding it.** Add one print inside the loop that shows the position, the
amount and the balance after it. The negative balance then appears on screen
next to its position. If you prefer a debugger, put `breakpoint()` at the top
of the loop and type `p balance, amount`.

**Why the perf tier is here.** You could work out the balance on every entry
by adding up everything accepted so far. That gives the right answer, but on
200,000 entries it is twenty billion additions. Keep a running balance in a
variable instead. It is the same number, and each entry adds to it once.
:::
