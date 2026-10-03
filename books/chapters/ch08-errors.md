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

Those eleven lines name the file, the line, and the exact thing Python could
not do. Reading them takes a minute. Without them, you re-check 312 rows by
eye.

## Read it from the bottom

Here is a smaller version of that script, with four rows:

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

Running it prints this:

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

**The last line says what went wrong.** `ValueError: invalid literal for int()
with base 10: 'twelve'` means Python was asked to turn the text `'twelve'`
into a number, and it has no digits. The message quotes the bad value.

**The lines above show how the program got there.** Each `File ... line N`
block is a call that had not finished yet. Reading up from the bottom: it
failed inside `read_cents`, at line 5. `read_cents` was called by `total`, at
line 11. `total` was called from the bottom of the file, at line 15.

The calls are printed in the order they were made, so the one that failed is
at the bottom. Start there and read upward. The `^^^^` marks point at the part
of the line Python means.

The two most useful lines are the last one and the lowest `File` line that
names a file *you* wrote. Lines between them are usually other people's code.

:::figure{id="reading-a-traceback"}
Four lines, read from the bottom up.
:::

Here is the same failure, run live. `traceback.print_exc` prints what Python
prints when nothing catches the error. The `try` keeps the rest of the page
running, and `file=sys.stdout` shows the text here.

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

These seven errors are the ones you will see most often.

| Error | What Python is telling you |
|---|---|
| `NameError` | you used a name that holds nothing. A typo, or a line that never ran |
| `TypeError` | right idea, wrong kind of value: `"2" + 3` |
| `ValueError` | right kind, impossible content: `int("twelve")` |
| `IndexError` | that position is past the end of the list |
| `KeyError` | that key is not in the dictionary |
| `ZeroDivisionError` | you divided by zero |
| `IndentationError` | the spaces at the front of a line do not line up |

Six of those happen while your program runs. `IndentationError` happens
earlier. Python reads the whole file before running any of it, so a badly
indented line stops the program before the first instruction:

```text
  File "/Users/erniesg/crooked.py", line 5
    return running
                  ^
IndentationError: unindent does not match any outer indentation level
```

There is no `Traceback` header and no list of calls, because nothing had
started yet.

## Catching one instead of crashing

`try` runs a block. If that block raises `SomeError`, `except SomeError` runs
instead of the program stopping. `as problem` gives the error a name, so you
can print its message.

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

`KeyError`'s message is only the key it could not find, `'south'`.

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

If you leave the error name off, `except` catches every error:

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

The total is 0 and no error appears. The typo `read_cnts` raises `NameError`
on every row. The bare `except` caught each one, `pass` discarded it, and the
function returned 0 as if it were the total.

Name the error you expect, and the typo shows up:

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

`except ValueError` catches the bad rows you expected. Any other error, like
this `NameError`, still reaches you.

## Say which row

When you skip a bad row, print which row it was:

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

`enumerate` gives you the position along with the value. `!r` prints the
value with its quotes, so you can tell `12` from `"12 "`. Now the volunteer has
one row to fix, not 312 to re-read.

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

When a function has no sensible answer to return, it can raise an error
itself:

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

Returning `0` or `None` instead would let another function add it to a total.
The wrong number would show up later, with nothing pointing back here.

Choose the error that fits. `TypeError` means the wrong *kind* of value
arrived, such as text where a number belonged. `ValueError` means the kind was
right but the value was impossible, such as a negative count, an empty list or
zero people.

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

The agent you build edits code and then runs the tests. When a test fails,
it gets a traceback. The last line tells it what the error was. The lowest
`File` line in one of the project's own files tells it where. It needs both.

The agent's tools raise errors too. A tool given a path that does not exist
should raise, not return an empty string that the next step pastes into a
file.

## Your turn

Two challenges. The first walks you through choosing between `TypeError` and
`ValueError`. The second has no hints: you get messy input and have to report
which line was bad without crashing.
