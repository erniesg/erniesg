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
exact amount, and the bank file holds 200,000 lines for the year, oldest first.

Before she writes the difference off, she wants to know whether two single
lines on the statement add up to exactly it. Not a run of lines: two.

Answer with the position of the line that *completes* such a pair: the first
line in the file that, together with some line above it, adds up to the target.
Everything below that line is somebody else's problem. If no two lines add up
to the target, answer -1.

Amounts can be negative. Money goes out as well as in.
:::

:::io
input: `amounts`, a list of whole numbers of pence in file order, and `target`, a whole number of pence
output: the position of the earliest line that completes a pair summing to `target`, or -1
:::

:::constraints
- The file holds 0 to 200,000 lines.
- Each amount is a whole number between -1,000,000 and 1,000,000.
- `target` is a whole number between -2,000,000 and 2,000,000.
- The two lines must sit at different positions. One line cannot pair with
  itself, however conveniently it is half the target.
- Positions are counted from 0.
- The file you were handed must come back unchanged.
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
Every line asks one membership question about everything above it. The flat
line is the one you need; the other one is the every-pair answer.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Do the arithmetic first. Every line against every earlier line is
200,000 × 200,000 ÷ 2, which is 20 billion additions. At ten million steps a
second that is 2,000 seconds. Even if the rule is four times too gloomy, eight
minutes does not fit in three seconds. One pass, one loop, nothing inside it.
:::

:::hint{level=2}
Walk the file once, top to bottom. At each line you need the answer to exactly
one question about all the lines above it, and it is a yes-or-no question.
:::

:::hint{level=3}
The question is: **have I already seen `target - amount`?** If this line is
£2.00 and the target is £7.00, the line that completes the pair is a £5.00 one,
and you either passed one already or you did not. A set answers that without
caring how much is in it.
:::

:::hint{level=4}
Order inside the loop decides one case. Ask the question first, then add the
current amount to the set. Do it the other way round and `[700]` with a target
of 1400 pairs the line with itself and answers 0 instead of -1.
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

**The move.** You do not search for the partner. You work out what the partner
would have to be — `target - amount`, one subtraction — and ask whether you
have met it. That turns "find something" into "is this in here", which is the
one question a hash set answers without looking at its contents.

This is worth naming, because it comes up constantly: **a key you look up does
not have to be a key you deliberately stored.** Anything you can compute is a
key. Here the computed key is the missing half of a sum.

**Why one pass is enough for "earliest".** Walking top to bottom, the first
time the question comes back yes is by definition the first line that completes
a pair. There is nothing to compare afterwards and nothing to keep track of but
the set.

**The order of those two lines.** `if` first, `add` second. Reverse them and
the current line is already in the set when you ask about it, so a line worth
exactly half the target pairs with itself. `[700]` with a target of 1400 is the
whole test, and it is the reason the edge tier holds it.

**Counting it.** One subtraction, one set lookup and one set insert per line.
At 200,000 lines that is under a million steps and measures at about two
hundredths of a second. The every-pair version, run on the same file, is still
going twenty minutes later.

**What the negative amounts are doing in the constraints.** They stop you
pruning. With only positive amounts you could skip any line above the target
and the every-pair version might scrape through. With refunds in the file there
is nothing to skip, and the shape of the answer has to be right rather than
lucky.

**A near miss worth knowing about.** A dict instead of a set gives you more for
the same pass — store `amount: position` and you can report *both* lines, not
just the later one. Same cost, same shape. If anybody is ever going to ask
which two lines, that is the version to have written.
:::
