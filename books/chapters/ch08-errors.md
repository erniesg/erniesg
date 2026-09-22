+++
id = "ch08-errors"
kind = "concept"
title = "Errors and tracebacks"
figure = "reading-a-traceback"

teaches = ["errors-and-tracebacks"]
requires = ["ch07-strings"]
assessed-by = ["change-owed", "bad-row-report"]
powers = ["agent-reads-its-own-failures"]
+++

A volunteer copies 312 rows off a paper sign-up sheet into a text file, one
donation in cents per line, and runs a script that adds them up. The treasurer
wants the total at 5pm. At 4:41 the script prints no total. It prints eleven
lines of text and stops.

Those eleven lines are not noise. They name the file, the line, and the exact
thing Python refused to do. Read them and this costs a minute. Ignore them and
you re-check 312 rows by eye.

## Read it from the bottom

Here is a smaller version of that script, four rows instead of 312:

```python
rows = ["1200", "850", "twelve", "3000"]


def read_cents(text):
    return int(text)


def total(rows):
    running = 0
    for row in rows:
        running += read_cents(row)
    return running


print(total(rows))
```

Run it and you get this:

```text
Traceback (most recent call last):
  File "/Users/erniesg/donations.py", line 15, in <module>
    print(total(rows))
          ^^^^^^^^^^^
  File "/Users/erniesg/donations.py", line 11, in total
    running += read_cents(row)
               ^^^^^^^^^^^^^^^
  File "/Users/erniesg/donations.py", line 5, in read_cents
    return int(text)
           ^^^^^^^^^
ValueError: invalid literal for int() with base 10: 'twelve'
```

**The last line is what went wrong.** `ValueError: invalid literal for int()
with base 10: 'twelve'`. Python was handed the text `'twelve'` and asked to
make a number of it. There is no number in it. That is the entire fact, and it
even quotes the offending value back to you.

**The lines above are how you got there.** Each `File ... line N` block is a
call that was still in progress. Reading up from the bottom: it broke inside
`read_cents`, at line 5. `read_cents` was called by `total`, at line 11.
`total` was called from the bottom of the file, at line 15.

So the route is printed in the order it was built, and you want it in the
order it collapsed. Hence: bottom first, then upward. The `^^^^` marks are
Python pointing at the part of the line it means.

Two lines carry nearly all of it: the last one, and the lowest `File` line
naming a file *you* wrote. Everything between them is usually somebody else's
code doing what you asked.

:::figure{id="reading-a-traceback"}
Four lines, read from the bottom up.
:::

Here is the same failure, live. The `try` is only so the rest of this page
keeps working, and `file=sys.stdout` only so the text lands here with
everything else; `traceback.print_exc` prints exactly what Python prints when
nothing catches the error.

```python run
import sys
import traceback

rows = ["1200", "850", "twelve", "3000"]

def read_cents(text):
    return int(text)

def total(rows):
    running = 0
    for row in rows:
        running += read_cents(row)
    return running

try:
    print(total(rows))
except ValueError:
    traceback.print_exc(file=sys.stdout)
```

## The handful you meet constantly

Seven names cover almost everything you will hit this year.

| Error | What Python is telling you |
|---|---|
| `NameError` | you used a name that holds nothing. A typo, or a line that never ran |
| `TypeError` | right idea, wrong kind of value: `"2" + 3` |
| `ValueError` | right kind, impossible content: `int("twelve")` |
| `IndexError` | that position is past the end of the list |
| `KeyError` | that key is not in the dictionary |
| `ZeroDivisionError` | you divided by zero |
| `IndentationError` | the spaces at the front of a line do not line up |

Six of those happen while your program runs. `IndentationError` is different:
Python reads the whole file before running any of it, so a crooked line stops
everything before the first instruction:

```text
  File "/Users/erniesg/crooked.py", line 5
    return running
                  ^
IndentationError: unindent does not match any outer indentation level
```

No `Traceback` header, no call chain. Nothing had started yet.

## Catching one instead of crashing

`try` says: attempt this. `except SomeError` says: if exactly that goes wrong,
do this instead of stopping. `as problem` gives the error a name, so you can
print what it said.

```python run
readings = [12, 9, 15]
rates = {"north": 4}

try:
    print(readings[7])
except IndexError as problem:
    print("IndexError:", problem)

try:
    print(rates["south"])
except KeyError as problem:
    print("KeyError:", problem)

try:
    print(int("twelve"))
except ValueError as problem:
    print("ValueError:", problem)

try:
    print(10 / 0)
except ZeroDivisionError as problem:
    print("ZeroDivisionError:", problem)
```

Look at how thin `KeyError`'s message is — just the key it could not find. It
is still the one fact you needed.

:::exercise{id="ch08-count-bad-as-zero"}
Add up the rows. A row that is not a number counts as 0 — catch exactly
`ValueError`, nothing wider.

```python
rows = ["12", "x", "30", ""]
total = 0
for row in rows:
    # your code here
    ...
print(total)
```

```output
42
```

```answer
rows = ["12", "x", "30", ""]
total = 0
for row in rows:
    try:
        total += int(row)
    except ValueError:
        pass
print(total)
```
:::

## A bare except is a trap

You can leave the error name off and catch everything. Do not.

```python run
def total_quietly(rows):
    running = 0
    for row in rows:
        try:
            running += read_cnts(row)
        except:
            pass
    return running

print(total_quietly(rows))
```

The total is zero, and nothing complained. There is a typo in there —
`read_cnts` instead of `read_cents` — which is a `NameError` on every single
row. The bare `except` caught it, `pass` threw it away, and the function
returned a number that looks like an answer.

Name the error you expect and the typo comes straight back out:

```python run
def total_loudly(rows):
    running = 0
    for row in rows:
        try:
            running += read_cnts(row)
        except ValueError:
            pass
    return running

try:
    print(total_loudly(rows))
except NameError as problem:
    print("NameError:", problem)
```

`except ValueError` catches the mess you planned for and lets the mess you did
not plan for reach you. That is the whole difference. A bare `except` turns
every future bug in that block into silence.

## Say which row

Skipping a bad row is fine. Skipping it in secret is not. Tell the person
which one:

```python run
def total_reporting(rows):
    running = 0
    for number, row in enumerate(rows, start=1):
        try:
            running += read_cents(row)
        except ValueError:
            print(f"row {number}: {row!r} is not a number — skipped")
    return running

print(total_reporting(rows))
```

`enumerate` hands you the position along with the value, and `!r` prints the
value with its quotes so you can see whether it is `12` or `"12 "`. Now the
volunteer has one row to fix, not 312 to re-read.

:::exercise{id="ch08-name-the-rows"}
Collect the row numbers, counting from 1, of rows that are not numbers. Print
them, then the total of the rows that were.

```python
rows = ["5", "five", "7", "", "3"]
bad = []
total = 0
# your code here
print("bad rows:", bad)
print("total:", total)
```

```output
bad rows: [2, 4]
total: 15
```

```answer
rows = ["5", "five", "7", "", "3"]
bad = []
total = 0
for number, row in enumerate(rows, start=1):
    try:
        total += int(row)
    except ValueError:
        bad.append(number)
print("bad rows:", bad)
print("total:", total)
```
:::

## Raise it yourself

Sometimes there is no sensible answer to give back. Say so, loudly, at the
moment you find out:

```python run
def cents_each(total_cents, people):
    if people <= 0:
        raise ValueError(f"people must be positive, got {people}")
    return total_cents // people

print(cents_each(5050, 5))
print(cents_each(5050, 0))
```

The first call works. The second raises, and the traceback names your function
and your message.

Returning `0` or `None` instead would have been a lie that travels: some other
function would have added it to a total, and the wrong number would surface
hours later with nothing pointing back here. `raise` puts the complaint where
the fault is.

Pick the name honestly. `TypeError` means the wrong *kind* of value arrived —
text where a number belonged. `ValueError` means the kind was right and the
content was impossible — a negative count, an empty list, zero people.

:::exercise{id="ch08-say-it-is-empty"}
An empty list has no average. Make `average` raise `ValueError` with the
message `no values to average` before it divides by zero.

```python
def average(values):
    # your code here
    return sum(values) / len(values)


print(average([2, 4]))
try:
    print(average([]))
except ValueError as problem:
    print("ValueError:", problem)
```

```output
3.0
ValueError: no values to average
```

```answer
def average(values):
    if not values:
        raise ValueError("no values to average")
    return sum(values) / len(values)


print(average([2, 4]))
try:
    print(average([]))
except ValueError as problem:
    print("ValueError:", problem)
```
:::

## What this buys the agent

The agent you build edits code and then runs the tests. What comes back is a
traceback. If it reads only the last line it knows the error but not the
source; if it reads only the top it knows the entry point and nothing else. It
has to do what you just did: last line for the fact, lowest frame in a file
the project owns for the place.

It also raises. A tool handed a path that does not exist should stop there,
not return an empty string that the next step happily pastes into a file.

## Your turn

Two challenges. The first walks you through choosing between `TypeError` and
`ValueError`. The second has no hints: you get messy input and have to report
which line was bad without ever crashing on it.
