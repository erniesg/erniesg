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

Nothing in the badge code had changed. The fastest-eight function had sorted
the club's list of names into time order, in place, and never put it back.

## Hand back a new list. Don't rearrange the one you were given

Here is the crime, in four lines:

```python run
members = ["mia", "sam", "ada", "hal"]     # joining order


def shortlist(names):
    names.sort()                           # tidy, and permanent
    return names[:2]


print(shortlist(members))
print(members)
```

The first line of output is right. The second is the problem: `members` is no
longer in joining order, and nothing said so. The function was asked a
question and it rearranged the filing cabinet on its way out.

The fix is one letter and no cleverness:

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

This is not tidiness. A function that quietly changes its caller's list causes
a bug *somewhere else*, in code that looks fine, possibly months later. The
badge code was never wrong. It was reading a list that somebody else had turned
over.

So: take a list, return a new list. If you really do mean to change the
caller's list, put it in the name — `add_member(club, name)` reads like it
changes something, `shortlist` does not.

## A comprehension is a filter and a transform on one line

You will write "go through this list and keep some of it" hundreds of times.
The long way works:

```python run
times = [31, 48, 29, 55, 33]

fast = []
for t in times:
    if t < 40:
        fast.append(t)

print(fast)
```

The short way says the same thing in the order you'd say it out loud — what to
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

Note the second line of output. A comprehension always builds a new list, so
you get the no-mutation habit for free.

Do both at once when you mean both:

```python run
print([name.strip() for name in ["  mia ", "   ", "hal"] if name.strip()])
```

One warning. A comprehension is for one clear step. When it grows three
clauses and a condition you can't read aloud, write the loop back out. Short is
not the goal; readable is.

## `sorted` takes a key

`sorted` on plain numbers or plain text needs no help. On anything with parts,
you say which part to order by:

```python run
swimmers = [("mia", 31), ("sam", 48), ("ada", 29), ("hal", 33)]
print(sorted(swimmers, key=lambda pair: pair[1]))
```

`lambda pair: pair[1]` is a small function written where it is used: hand it a
pair, it gives back the second thing in the pair. `sorted` calls it once per
item and orders by what comes back.

Ask for the other direction with `reverse=True`, and break ties by handing back
two things instead of one:

```python run
swimmers = [("mia", 31), ("sam", 29), ("ada", 29), ("hal", 33)]
print(sorted(swimmers, key=lambda pair: pair[1], reverse=True))
print(sorted(swimmers, key=lambda pair: (pair[1], pair[0])))
```

The first line is slowest first: `reverse=True` flips the order and leaves the
key alone. The second settles a tie. Sam and Ada both swam 29, so the keys
`(29, "sam")` and `(29, "ada")` are compared on the number, which decides
nothing, and then on the name, which puts Ada ahead. Tie-breaking is a tuple,
not an `if`.

## Unpacking: naming both halves at once

Python will take a group apart and name the pieces:

```python run
first, second = ("ada", 29)
print(first, second)
```

Which makes the famous swap possible without a spare variable:

```python run
a, b = 1, 2
a, b = b, a
print(a, b)
```

The right-hand side is worked out completely before anything is assigned. That
is why it is a swap and not `a = b` followed by `b = a`, which would leave you
with two copies of 2.

Unpacking works in a `for` line too, and this is where it earns its keep:

```python run
for name, seconds in swimmers:
    print(name, "swam", seconds)
```

`name` and `seconds` beat `pair[0]` and `pair[1]` in every way that matters.
You can read the line six weeks later.

## `enumerate` when you need the position, `zip` for two lists

You can keep a counter by hand. It works, and it is two extra lines you have
to get right — set it up, and remember to move it on:

```python run
place = 1
for name, seconds in sorted(swimmers, key=lambda pair: pair[1]):
    print(place, name)
    place += 1
```

`enumerate` hands you the position with the value, and you pick where the
counting starts:

```python run
ordered = sorted(swimmers, key=lambda pair: pair[1])
for place, (name, seconds) in enumerate(ordered, start=1):
    print(place, name, seconds)
```

When two lists line up — names in one, times in another — `zip` walks them
together:

```python run
names = ["mia", "sam", "ada"]
seconds = [31, 29, 33]
for name, time_taken in zip(names, seconds):
    print(name, time_taken)

print(list(zip(names, seconds)))
```

`zip` stops at the shorter list. That is usually what you want and occasionally
a silent bug, so if the two lists must be the same length, check it.

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

`if not names` beats `if len(names) == 0`. Both work; one reads like a
sentence.

One trap, worth ten seconds of your attention. `0` is also false:

```python run
seconds = 0
if not seconds:
    print("this fires for a swimmer who took 0 seconds, too")
```

When the question is really "did we get a value at all?", ask that question:
`if seconds is None`. Truthiness is for "is there anything here", not for "is
this number missing".

## Return early instead of nesting four deep

Rules pile up, and each one adds an indent. Four levels in, nobody can see
which `if` the last line belongs to:

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

Every one of those branches is a special case that ends the story. So end it,
at the top, one line each:

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

Same answers, no `else` anywhere, and the ordinary case — a paid-up member —
sits at the bottom with no indentation at all. Deal with the awkward inputs
first and get them out of the way. What is left is the real work, and now you
can see it.

:::figure{id="six-idioms"}
:::

## What this buys the agent

Two things, and only one of them is about looks.

The agent edits code and then has to check its own work. An edit that changes a
list the rest of the program is still holding is the hardest kind of bug for it
to find, because the failing test is nowhere near the line that caused it. A
function that takes values in and hands new values out can be tested on its
own, which is what the agent needs to be able to trust itself.

The other thing: you will read what the agent writes. Code you can scan in ten
seconds gets reviewed. Code that needs a pencil and a quiet room does not get
reviewed, it gets approved, which is not the same and is how bad edits land.

## Your turn

Two challenges. The first tells you exactly what the function must promise,
hints included, and one of its tests checks that the list you were handed comes
back untouched. The second gives you the problem and nothing else.
