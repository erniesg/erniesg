+++
id = "ch10-idioms"
kind = "concept"
title = "Writing it the Python way"
figure = "six-idioms"

teaches = ["python-idioms"]
requires = ["ch09-stepping"]
assessed-by = ["tidy-the-register", "race-results"]
powers = ["agent-reviewable-code"]
+++

A swimming club has 28 members. Every Monday someone prints the fastest eight
over 50 metres, and every quarter the club posts a badge to its ten
longest-standing members. Both lists come out of the same file of names, kept
in the order people joined.

One Monday the fastest-eight code was tidied up. Three months later, ten badges
went to the ten fastest swimmers instead of the ten oldest members. Four of
them had joined that year.

The badge code had not changed. The fastest-eight function had sorted the
club's list of names into time order, in place, and never put it back.

## Hand back a new list. Don't rearrange the one you were given

```python run
members = ["mia", "sam", "ada", "hal"]     # joining order


def shortlist(names):
    names.sort()                           # tidy, and permanent
    return names[:2]


print(shortlist(members))
print(members)
```

The first line of output is right. The second shows that `members` is no
longer in joining order. Calling `shortlist` changed the caller's list.

The fix:

```python run
def shortlist(names):
    return sorted(names)[:2]               # a new list, ordered


members = ["mia", "sam", "ada", "hal"]
print(shortlist(members))
print(members)
```

`names.sort()` reorders the list you were handed. `sorted(names)` builds a new
list and leaves the original alone. Same for `names.reverse()` against
`reversed(names)`, and `names.append(x)` against `names + [x]`.

A function that changes its caller's list causes a bug in other code that
reads the list later. The badge code was correct. The list it read had been
reordered by another function.

So take a list and return a new list. If a function is meant to change the
caller's list, say so in its name: `add_member(club, name)` sounds like it
changes something, and `shortlist` does not.

:::exercise{id="ch10-top-two"}
Return the two highest scores, highest first, without changing the list
passed in.

```python
def top_two(scores):
    # your code here
    ...


scores = [31, 48, 29, 55]
print(top_two(scores))
print(scores)
```

```output
[55, 48]
[31, 48, 29, 55]
```

```answer
def top_two(scores):
    return sorted(scores, reverse=True)[:2]


scores = [31, 48, 29, 55]
print(top_two(scores))
print(scores)
```
:::

## A comprehension is a filter and a transform on one line

Going through a list and keeping some of it is a common job. The long way:

```python run
times = [31, 48, 29, 55, 33]

fast = []
for t in times:
    if t < 40:
        fast.append(t)

print(fast)
```

A comprehension does it on one line, in the order you would say it: what to
collect, where from, which ones:

```python run
fast = [t for t in times if t < 40]
print(fast)
```

Drop the `if` and it transforms instead of filtering:

```python run
raw = ["  mia ", "SAM", "ada  "]
tidy = [name.strip().title() for name in raw]
print(tidy)
print(raw)
```

`raw` is unchanged, because a comprehension always builds a new list.

It can filter and transform at once:

```python run
print([name.strip() for name in ["  mia ", "   ", "hal"] if name.strip()])
```

A comprehension suits one clear step. If it needs several clauses and a long
condition, a loop is easier to read.

:::exercise{id="ch10-penalty"}
One comprehension: keep the times under 40 and add a 2-second penalty to each
one you keep.

```python
times = [31, 48, 29, 55, 33]
penalised = ...
print(penalised)
```

```output
[33, 31, 35]
```

```answer
times = [31, 48, 29, 55, 33]
penalised = [t + 2 for t in times if t < 40]
print(penalised)
```
:::

## `sorted` takes a key

`sorted` orders plain numbers or text by themselves. For items with parts, you
say which part to order by:

```python run
swimmers = [("mia", 31), ("sam", 48), ("ada", 29), ("hal", 33)]
print(sorted(swimmers, key=lambda pair: pair[1]))
```

`lambda pair: pair[1]` is a small function written where it is used. Given a
pair, it returns the pair's second item. `sorted` calls it once per item and
orders by what it returns.

`reverse=True` orders the other way. To break ties, return two things instead
of one:

```python run
swimmers = [("mia", 31), ("sam", 29), ("ada", 29), ("hal", 33)]
print(sorted(swimmers, key=lambda pair: pair[1], reverse=True))
print(sorted(swimmers, key=lambda pair: (pair[1], pair[0])))
```

The first line is slowest first. The second settles a tie. Sam and Ada both
swam 29, so their keys `(29, "sam")` and `(29, "ada")` are equal on the number.
Python then compares the names, which puts Ada ahead. A tuple key breaks the
tie without an `if`.

:::exercise{id="ch10-time-then-name"}
Order the swimmers by time, and where two times tie, by name.

```python
swimmers = [("sam", 29), ("mia", 31), ("ada", 29)]
# your code here
```

```output
[('ada', 29), ('sam', 29), ('mia', 31)]
```

```answer
swimmers = [("sam", 29), ("mia", 31), ("ada", 29)]
print(sorted(swimmers, key=lambda pair: (pair[1], pair[0])))
```
:::

## Unpacking: naming both halves at once

Python will take a group apart and name the pieces:

```python run
first, second = ("ada", 29)
print(first, second)
```

This lets you swap two values without a spare variable:

```python run
a, b = 1, 2
a, b = b, a
print(a, b)
```

The right-hand side is worked out in full before anything is assigned. `a = b`
followed by `b = a` would instead leave two copies of 2.

Unpacking also works in a `for` line:

```python run
for name, seconds in swimmers:
    print(name, "swam", seconds)
```

`name` and `seconds` say what each value is; `pair[0]` and `pair[1]` don't.

## `enumerate` when you need the position, `zip` for two lists

You can keep a counter by hand. That takes two extra lines: one to set it up
and one to move it on.

```python run
place = 1
for name, seconds in sorted(swimmers, key=lambda pair: pair[1]):
    print(place, name)
    place += 1
```

`enumerate` gives you the position with each value. `start=1` makes it count
from 1:

```python run
ordered = sorted(swimmers, key=lambda pair: pair[1])
for place, (name, seconds) in enumerate(ordered, start=1):
    print(place, name, seconds)
```

When two lists line up, names in one and times in the other, `zip` walks them
together:

```python run
names = ["mia", "sam", "ada"]
seconds = [31, 29, 33]
for name, time_taken in zip(names, seconds):
    print(name, time_taken)

print(list(zip(names, seconds)))
```

`zip` stops at the end of the shorter list, without an error. If the two lists
must be the same length, check that yourself.

:::exercise{id="ch10-results-board"}
Names and times arrive as two lists. Print a results board, fastest first:
place (from 1), name, time.

```python
names = ["mia", "sam", "ada"]
seconds = [31, 29, 33]
# your code here
```

```output
1 sam 29
2 mia 31
3 ada 33
```

```answer
names = ["mia", "sam", "ada"]
seconds = [31, 29, 33]
board = sorted(zip(names, seconds), key=lambda pair: pair[1])
for place, (name, time_taken) in enumerate(board, start=1):
    print(place, name, time_taken)
```
:::

## Empty things are False, and that reads like English

Python will treat an empty list, empty text, `0` and `None` as false when you
ask a yes-or-no question about them:

```python run
names = []
if not names:
    print("nobody has signed up")

if names:
    print("this does not print")
```

`if not names` and `if len(names) == 0` do the same thing; the first is
shorter.

`0` is also false:

```python run
seconds = 0
if not seconds:
    print("this fires for a swimmer who took 0 seconds, too")
```

When the question is "did we get a value at all?", write `if seconds is None`.
Use `if not x` to ask whether a list or text is empty, not whether a number is
missing.

## Return early instead of nesting four deep

Each rule nested inside another adds an indent. Four levels in, it is hard to
see which `if` a line belongs to:

```python
def entry_fee(age, is_member, has_paid):
    if age is not None:
        if age < 16:
            return 0
        else:
            if is_member:
                if has_paid:
                    return 0
                else:
                    return 3
            else:
                return 8
    else:
        return None
```

Each of those branches ends the function. So handle each one at the top and
return:

```python run
def entry_fee(age, is_member, has_paid):
    if age is None:
        return None
    if age < 16:
        return 0
    if not is_member:
        return 8
    if not has_paid:
        return 3
    return 0


print(entry_fee(None, False, False), entry_fee(12, False, False))
print(entry_fee(30, False, False), entry_fee(30, True, False))
print(entry_fee(30, True, True))
```

The answers are the same, there is no `else`, and the ordinary case, a paid-up
member, sits at the bottom with no extra indent. The special inputs are handled
first, so the main case is easy to find.

:::figure{id="six-idioms"}
:::

## What this buys the agent

The agent edits code and then checks its own work. If an edit changes a list
that other code still uses, the failing test can be far from the line that
caused it. A function that takes values and returns new ones can be tested on
its own.

You will also read what the agent writes. Code that is quick to read is easier
to review properly, so fewer bad edits get through.

## Your turn

Two challenges. The first states exactly what the function must do and has
hints; one test checks that the list passed in is unchanged. The second gives
you the problem and nothing else.
