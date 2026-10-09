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

Before he spends anything else, he wants to know what this month's dips will
cost him. Forty-three subtractions by hand take ten minutes, and it is easy to
get a digit wrong without noticing. A loop does it in four lines.

## Doing the same thing to every item

Here are five of his payments. The same loop works for forty-three.

```python run
payments = [45, 30, 28, 40, 19]
for payment in payments:
    print(payment)
```

Each time round, Python sets `payment` to the next item. First it holds 45,
then 30, and so on until the list runs out. You don't count or use positions;
you get one item, then the next.

## Keeping a running total

To follow the balance, you need a name that keeps its value from one time
round to the next.

```python run
balance = 120
for payment in payments:
    balance = balance - payment
    print(balance)
```

He is under by the fourth payment. `balance` is set once, *before* the loop,
and each time round changes it. Set inside the loop, it restarts at 120 every
time:

```python run
balance = 120
for payment in payments:
    balance = 120
    balance = balance - payment
print(balance)
```

101 is 120 minus 19, the last payment only. A name that collects a total
has to be set before the loop.

:::exercise{id="ch04-add-them-up"}
No `sum()` allowed. Add the payments up with a loop and print the total.

```python
payments = [45, 30, 28, 40, 19]
total = 0
for payment in payments:
    # your code here
    ...
print(total)
```

```output
162
```

```answer
payments = [45, 30, 28, 40, 19]
total = 0
for payment in payments:
    total = total + payment
print(total)
```
:::

## Keeping the best so far

One more name in the same loop tracks how low the balance went:

```python run
balance = 120
lowest = 120
for payment in payments:
    balance = balance - payment
    if balance < lowest:
        lowest = balance
print(lowest)
```

`lowest` starts at 120 because 120 is a balance the account really had. If
it started at 0, an account that never dipped would report a low of 0, which
it never had. Start a best-so-far at a real value from the data.

:::exercise{id="ch04-biggest-payment"}
No `max()` allowed. Print the biggest payment, starting your best-so-far at a
value that really is in the list.

```python
payments = [30, 45, 28, 40, 19]
biggest = ...
for payment in payments:
    # your code here
    ...
print(biggest)
```

```output
45
```

```answer
payments = [30, 45, 28, 40, 19]
biggest = payments[0]
for payment in payments:
    if payment > biggest:
        biggest = payment
print(biggest)
```
:::

## Counting, with a condition

Now the charges:

```python run
balance = 120
charged = 0
for payment in payments:
    balance = balance - payment
    if balance < 0:
        charged = charged + 8
print(charged)
```

Two dips cost 16. A single loop can keep as many names as you need, so one
pass could find the running balance, the lowest point and the charge together.

:::figure{id="running-balance"}
Two names updated as the marker moves, not worked out afterwards.
:::

:::exercise{id="ch04-thirty-or-more"}
Count the payments of 30 **or more**. A payment of exactly 30 counts.

```python
payments = [45, 30, 28, 40, 19]
count = 0
# your code here
print(count)
```

```output
3
```

```answer
payments = [45, 30, 28, 40, 19]
count = 0
for payment in payments:
    if payment >= 30:
        count = count + 1
print(count)
```
:::

## enumerate, when the position matters

He also wants to know *which* payment took him under, so he can move it.
`enumerate` gives you the position along with the item.

```python run
balance = 120
for position, payment in enumerate(payments):
    balance = balance - payment
    if balance < 0:
        print("payment", position, "of", len(payments), "took it under, to", balance)
        break
```

Positions count from zero, so payment 3 is the fourth one: the 40.

`break` leaves the loop straight away. Without it, the message would print
for every later payment too, because the balance stays below zero.

:::exercise{id="ch04-first-big-one"}
Print the position of the first payment over 35, then stop looking.

```python
payments = [12, 30, 41, 28, 50]
# your code here
```

```output
2
```

```answer
payments = [12, 30, 41, 28, 50]
for position, payment in enumerate(payments):
    if payment > 35:
        print(position)
        break
```
:::

## break and continue

`break` ends the loop. `continue` ends only this time round and moves on to the
next item.

```python run
for payment in payments:
    if payment < 25:
        continue
    print(payment)
```

For the 19, the lines below `continue` don't run, so it isn't printed.

## range, and the number it stops at

Sometimes you want the numbers themselves rather than items out of a list.

```python run
for week in range(5):
    print(week)
```

`range(5)` gives five numbers, 0 to 4. The number is how many, not the
last one.

```python run
print(list(range(5)))
print(list(range(1, 6)))
print(list(range(0, 20, 5)))
```

With two arguments you give a start and a stop, and the stop is still left
out. A third argument sets the step.

To get positions and items from a list, use `enumerate` rather than looking
items up with `range(len(payments))`.

## while, for when you do not know how many

`for` walks along a list or a range. `while` repeats as long as a test stays
true. Use it when the *number of rounds* is what you want to find out.

He is 42 under and puts 25 aside a week. How many weeks until he is 100 clear?

```python run
balance = -42
weeks = 0
while balance < 100:
    balance = balance + 25
    weeks = weeks + 1
print(weeks, balance)
```

A `while` loop that finishes has three parts:

1. The test is true when the loop starts. `-42 < 100`.
2. Something in the body changes a name the test uses. `balance` grows by 25.
3. That change moves the test towards false, and gets there.

Here is the loop without the line that changes the balance:

```python
balance = -42
weeks = 0
while balance < 100:
    weeks = weeks + 1
print(weeks)
```

If you ran it, `balance` would stay at -42, the test would stay true, and the
loop would never end until you stopped the program.

Point three can fail even when something does change. If he put aside 0 a
week, the balance would change by 0 each round and never reach 100. The loop
can't answer that case, so check for it with an `if` before the loop.

:::exercise{id="ch04-weeks-to-save"}
He starts at 0 and puts 30 aside each week. Use a `while` loop to print how
many weeks until he has at least 200.

```python
balance = 0
weeks = 0
# your code here
print(weeks)
```

```output
7
```

```answer
balance = 0
weeks = 0
while balance < 200:
    balance = balance + 30
    weeks = weeks + 1
print(weeks)
```
:::

## Changing a list while you walk it

Chapter 3 removed items from a list while looping over it. Here is the same
mistake with payments:

```python run
amounts = [10, 5, 5, 40]
for amount in amounts:
    if amount < 25:
        amounts.remove(amount)
print(amounts)
```

A 5 is still there. Removing the 10 moves everything down one place. The
loop looks at position 1 next, which now holds the second 5, so the first 5 is
skipped. Removing a 5 leaves `[5, 40]`, which has no position 2, so the loop
stops before it reaches the 40.

The fix is the same: read one list and build another.

```python run
amounts = [10, 5, 5, 40]
kept = []
for amount in amounts:
    if amount >= 25:
        kept.append(amount)
print(kept)
```

## What this buys the agent

The agent walks a repository of, say, 1,400 files, deciding which are worth
reading. It keeps a running count of the tokens it has spent and the
best-matching file so far. It uses `continue` to skip files it cannot parse,
`break` when the budget runs out, and `enumerate` so the progress line can say
812 of 1,400.

The agent also collects the edits it wants while walking the files, and
applies them after the walk. If it changed the files while walking them, it
could skip some of its own work and still report success.

## Your turn

Two challenges, both solved in a single pass. The first walks you through it.
The second gives hints; try to pass it before reading the worked solution. Its
last tier needs a loop that does not count days one at a time.
