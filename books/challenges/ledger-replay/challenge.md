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

The starter is already written and it is already wrong. The card it describes
can go below zero, which is the one thing the machine promises cannot happen.
Find out where, and read the tests to learn what should have happened instead.
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
- The balance is never below zero, at any point, ever.
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
Print the balance on every entry and the line that breaks the promise stands out.
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

**What the bug actually was.** The starter added the amount first and then
looked at the result. By the time it noticed the balance was negative, the
balance *was* negative, and nothing put it back. It logged the refusal
correctly and refused nothing.

`[500, -200, -400, 100]` shows it: 500, then 300, then -100 with position 2
logged, then 0. The right answer is 400, because the -400 never happened.

**Ask before, not after.** `balance + amount < 0` works out what would happen
without letting it happen. That is the shape of every rule like this one: test
the move, then make it, never the other way round.

**Why the `amount < 0` part matters.** Without it the test is just
`balance + amount < 0`, which is the same answer for a top-up as for a fare —
a top-up can never take you below zero. It reads better with it, and it says
out loud which entries the rule is about. Leave it out and the code still
passes; the next person still has to work out why.

**Finding it.** One print inside the loop, showing the position, the amount and
the balance after, and the negative number is on the screen with its position
next to it. `breakpoint()` on the line before and `p balance, amount` gives the
same answer if you would rather poke at it than read it.

**Why the perf tier is here.** The obvious way to be sure of the balance is to
add up everything you have accepted so far, on every entry. That is right, and
on 200,000 entries it is twenty billion additions. Keep the running balance in
a name instead; it is the same number, worked out once.
:::
