+++
id = "ch04-loops"
kind = "concept"
title = "Repeating with loops"
figure = "running-balance"

teaches = ["loops"]
requires = ["ch03-lists"]
assessed-by = ["overdraft-fees", "meter-days"]
powers = ["agent-repository-walk"]
+++

A man has 120 in his account and forty-three payments to get through before
payday. Every time the balance dips below zero the bank takes 8, and it takes
it on every dip, not once a month.

Before he spends anything else he wants one number: what this month's dips will
cost him. Forty-three subtractions by hand take ten minutes, and somewhere in
the middle he will slip a digit and not know it. A loop takes four lines and
does not slip.

## Doing the same thing to every item

Here are five of his payments. The loop below would be the same for
forty-three.

```python run
payments = [45, 30, 28, 40, 19]
for payment in payments:
    print(payment)
```

`payment` is a name Python re-points for you. First time round it holds 45,
then 30, and so on until the list runs out. Nothing is counted and nothing is
looked up by position — you get one item, then the next.

## Keeping a running total

The account is the interesting part, and it needs a name that survives from one
time round to the next.

```python run
balance = 120
for payment in payments:
    balance = balance - payment
    print(balance)
```

He is under by the fourth payment. `balance` is created once, *before* the
loop; each time round changes it. Move that first line inside the loop and it
is built fresh every time, which quietly answers a different question:

```python run
balance = 120
for payment in payments:
    balance = 120
    balance = balance - payment
print(balance)
```

101 is 120 minus 19, the last payment and nothing else. No crash, no error
message, and on the page it looks almost identical to the working version.
Accumulators go before the loop.

## Keeping the best so far

Same pass, one more name. How low did it actually get?

```python run
balance = 120
lowest = 120
for payment in payments:
    balance = balance - payment
    if balance < lowest:
        lowest = balance
print(lowest)
```

`lowest` starts at 120 because 120 is a balance that really happened. Start it
at 0 instead and an account that never dipped would report a low of 0 — a
number that was never true of it. Whatever you are tracking, start it at
something genuinely in the running.

## Counting, with a condition

Now his actual question.

```python run
balance = 120
charged = 0
for payment in payments:
    balance = balance - payment
    if balance < 0:
        charged = charged + 8
print(charged)
```

Two dips, 16. One pass answered all three questions — the running balance, the
lowest point, the charge — because a loop can carry as many names as you give
it.

:::figure{id="running-balance"}
Two names updated as the marker moves, not worked out afterwards.
:::

## enumerate, when the position matters

He also wants to know *which* payment tipped him, so he can move it. `enumerate`
hands you the position along with the item.

```python run
balance = 120
for position, payment in enumerate(payments):
    balance = balance - payment
    if balance < 0:
        print("payment", position, "of", len(payments), "took it under, to", balance)
        break
```

Positions count from zero, so payment 3 is the fourth one: the 40.

`break` leaves the loop on the spot. Without it the message prints for every
later payment too, since the balance stays under once it is under.

## break and continue

`break` ends the loop. `continue` ends only this time round and moves on to the
next item.

```python run
for payment in payments:
    if payment < 25:
        continue
    print(payment)
```

The 19 is missing. Everything below `continue` in the loop body is simply not
reached for that item.

## range, and the number it stops at

Sometimes you want the numbers themselves rather than items out of a list.

```python run
for week in range(5):
    print(week)
```

`range(5)` gives five numbers and the last one is 4. This catches everyone
once. Read `range(5)` as *how many*, never as *up to*.

```python run
print(list(range(5)))
print(list(range(1, 6)))
print(list(range(0, 20, 5)))
```

Two arguments give a start and a stop, and the stop is still left out. Three
give you a step.

If you catch yourself writing `range(len(payments))` in order to look items up
by position, you wanted `enumerate`.

## while, for when you do not know how many

`for` needs something to walk along. `while` just repeats as long as a question
stays true, which is what you want when the *number of rounds* is the answer
you are after.

He is 42 under and puts 25 aside a week. How many weeks until he is 100 clear?

```python run
balance = -42
weeks = 0
while balance < 100:
    balance = balance + 25
    weeks = weeks + 1
print(weeks, balance)
```

Every `while` needs three things, and a loop that runs forever is missing the
third.

1. The question is true when you arrive. `-42 < 100`.
2. Something in the body changes a name the question asks about. `balance`
   grows by 25.
3. That change moves the question towards false, and gets there.

Drop the line that changes the balance and the first two still hold:

```python
balance = -42
weeks = 0
while balance < 100:
    weeks = weeks + 1
print(weeks)
```

Do not run that one. `balance` stays at -42, the question stays true, and the
program sits there until you kill it.

Point three is the one people miss even when something does change. If he put
aside 0 a week, the balance moves by 0 each round and never arrives. That is
not a bug in the loop — it is a case the loop cannot answer, and it belongs in
an `if` before the loop rather than a guess inside it.

## Changing a list while you walk it

This looks reasonable. It is not.

```python run
amounts = [10, 5, 5, 40]
for amount in amounts:
    if amount < 25:
        amounts.remove(amount)
print(amounts)
```

A 5 survived. Underneath, the loop walks by position: it hands you position 0,
then 1, then 2. Removing the 10 slides the first 5 down into position 0 — a
position already passed — so position 1 now holds the *second* 5, and that is
what the loop hands you next. One of the two is never visited at all, and the
shrinking list runs out before the loop has been all the way along it.

Read one list, build another.

```python run
amounts = [10, 5, 5, 40]
kept = []
for amount in amounts:
    if amount >= 25:
        kept.append(amount)
print(kept)
```

## What this buys the agent

The agent walks a repository — say 1,400 files — deciding file by file what is
worth reading. That is this chapter and very little else: a running count of
the tokens it has spent, the best-matching file so far, `continue` past the
ones it cannot parse, `break` the moment the budget is gone, `enumerate` so the
progress line can say 812 of 1,400.

The list rule matters more to an agent than to a person. It gathers the edits
it wants while walking the files, then applies them once the walk is over.
Changing the thing you are in the middle of reading is how an agent skips half
its own work and reports success.

## Your turn

Two challenges, both a single pass. The first walks you through it. The second
gives you hints and keeps its solution shut until all four tiers are green —
and its last tier will not accept a loop that counts days one at a time.
