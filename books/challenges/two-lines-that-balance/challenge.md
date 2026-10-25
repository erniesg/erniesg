+++
id = "two-lines-that-balance"
kind = "challenge"
title = "The two lines that make up the difference"
module = "balance"
figure = "lookup-vs-scan"
support = "contract"
difficulty = 3

requires = ["ch12-hash-maps"]
teaches = ["hash-maps"]
tags = ["part-2", "hash-maps", "one-pass"]

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 10
timeout = 30

[tiers.edge]
xp = 20
timeout = 30

[tiers.stress]
xp = 25
timeout = 60

[tiers.perf]
xp = 25
timeout = 15
+++

:::statement
A treasurer is closing a charity's year. The books and the bank disagree by an
exact amount. The bank file holds 200,000 lines for the year, oldest first.

Before she writes the difference off, she wants to know whether two single
lines add up to exactly that amount.

Return the position of the line that *completes* such a pair: the first line
that adds up to the target together with some line above it. If no two lines
add up to the target, return -1.

Amounts can be negative, because money goes out as well as in.
:::

:::io
input: `amounts`, a list of whole numbers of pence in file order, and `target`, a whole number of pence
output: the position of the earliest line that completes a pair summing to `target`, or -1
:::

:::constraints
- The file holds 0 to 200,000 lines.
- Each amount is a whole number between -1,000,000 and 1,000,000.
- `target` is a whole number between -2,000,000 and 2,000,000.
- The two lines must be at different positions. One line cannot pair with
  itself, even when it is exactly half the target.
- Positions are counted from 0.
- The list you were given must stay unchanged.
- Checking every pair is too slow to pass.
:::

:::sample
| amounts | target | Output | Why |
|---|---|---|---|
| `[300, 500, 200, 700]` | `700` | `2` | 500 + 200, completed at position 2 |
| `[300, 500, 200, 700]` | `1000` | `3` | 300 + 700, and nothing earlier works |
| `[-250, 250]` | `0` | `1` | a refund cancels a charge |
| `[700]` | `1400` | `-1` | one line cannot be used twice |
| `[]` | `0` | `-1` | nothing to reconcile |
:::

:::figure{id="lookup-vs-scan"}
At each line you ask one question about the lines above: is the missing half
among them? The flat line is the one you need. The other is the every-pair
answer.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Do the arithmetic first. Every line against every earlier line is
200,000 × 200,000 ÷ 2, which is 20 billion additions. At ten million steps a
second that is 2,000 seconds. Even at four times that speed it is about eight
minutes, and the perf tier allows three seconds. You need one loop, with no
loop inside it.
:::

:::hint{level=2}
Walk the file once, top to bottom. At each line you need the answer to one
yes-or-no question about all the lines above it.
:::

:::hint{level=3}
The question is: **have I already seen `target - amount`?** If this line is
£2.00 and the target is £7.00, the other line must be £5.00. A set answers
"have I seen it?" just as fast however much is in it.
:::

:::hint{level=4}
Inside the loop, ask the question first, then add the current amount to the
set. The other way round, `[700]` with a target of 1400 pairs the line with
itself and returns 0 instead of -1.
:::

:::solution
```python
def first_balancing_line(amounts, target):
    seen = set()
    for position, amount in enumerate(amounts):
        if target - amount in seen:
            return position
        seen.add(amount)
    return -1
```

**The idea.** You do not search for the other line. You work out what it would
have to be, `target - amount`, and ask whether you have seen it. That turns
"find something" into "is this in here", which a set answers without looking
through its contents.

This comes up often: **the key you look up does not have to be a value you
stored on purpose.** Anything you can compute can be a key. Here it is the
missing half of a sum.

**Why one pass finds the earliest line.** You walk top to bottom, so the first
yes comes at the first line that completes a pair. Nothing needs tracking
except the set.

**The order of those two lines.** `if` first, `add` second. Swapped, the current
line is already in the set when you ask, so a line worth half the target pairs
with itself. The edge tier tests this with `[700]` and a target of 1400.

**Counting the cost.** Each line costs one subtraction, one set lookup and one
set insert. At 200,000 lines that is under a million steps, measured at under
two hundredths of a second. The every-pair version, on the same file, is still
running nine minutes later.

**Why the constraints allow negative amounts.** With only positive amounts,
you could skip any line larger than the target, and the every-pair version
might be fast enough. With refunds in the file, no line can be skipped.

**A variation.** Use a dict in place of the set and store `amount: position`.
Then you can report *both* lines, not just the later one, at the same cost. If
someone might ask which two lines they were, write that version.
:::
