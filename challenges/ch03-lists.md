+++
id = "ch03-lists"
kind = "concept"
title = "Lists and how to use them"
figure = "two-names-one-list"

teaches = ["lists"]
requires = ["ch02-conditionals"]
assessed-by = ["recent-readings", "remove-every-copy"]
powers = ["agent-batches"]
+++

A food bank keeps nine tins on a shelf, and three of them — the third, fourth
and fifth along — are past their date. A volunteer walks the shelf, taking out
the bad ones as she goes.

She pulls out the third tin. Everything behind it slides one place forward, so
the next tin she looks at is the one that used to be fifth. The fourth is now
behind her, and it goes out in somebody's food parcel.

Nine things in a row is a list. That bug is one of the two this chapter is
really about; the other one quietly shares a list between two people who each
think they have their own.

## Values in a row, counted from 0

```python run
tins = ["beans", "rice", "soup", "beans"]
print(tins[0])      # the first one
print(tins[2])
print(len(tins))
```

The first position is 0, not 1, so the last position is always `len` minus
one. Reach past the end — `tins[4]` here — and Python raises `IndexError`
rather than inventing something.

Counting from the far end is written with a minus sign:

```python run
print(tins[-1])     # the last one
print(tins[-2])
```

:::exercise{id="ch03-first-and-last"}
Print the first tin and the last tin on one line, with positions that would
still work if the shelf were a hundred tins long.

```python
tins = ["beans", "rice", "soup", "pasta", "oil"]
# your code here
```

```output
beans oil
```

```answer
tins = ["beans", "rice", "soup", "pasta", "oil"]
print(tins[0], tins[-1])
```
:::

## Slicing: a piece of a list

```python run
readings = [3, 8, 2, 9, 4, 1]
print(readings[1:4])    # from 1, up to but not including 4
print(readings[:2])     # from the start
print(readings[-3:])    # the last three
print(readings[2:99])   # slicing never complains about running off the end
```

A slice is always a **new** list. The original is untouched, which makes
`readings[:]` — every position, from start to end — the short way to ask for a
copy. Hold on to that; it comes back at the end of the chapter.

:::exercise{id="ch03-last-three"}
Two slices: print the last three readings, then every reading except the
first.

```python
readings = [3, 8, 2, 9, 4, 1]
# your code here
```

```output
[9, 4, 1]
[8, 2, 9, 4, 1]
```

```answer
readings = [3, 8, 2, 9, 4, 1]
print(readings[-3:])
print(readings[1:])
```
:::

## Growing a list

```python run
shelf = ["beans", "rice"]
shelf.append("soup")             # one more item on the end
shelf.extend(["pasta", "oil"])   # several more
shelf.insert(0, "milk")          # squeeze in at a position
print(shelf)
```

`append` and `extend` are not interchangeable, and the difference is visible:

```python run
a = ["beans"]
b = ["beans"]
a.append(["pasta", "oil"])    # one new item, which happens to be a list
b.extend(["pasta", "oil"])    # two new items
print(a)
print(b)
```

`insert` shifts everything after it along by one place, so inserting at the
front of a long list is real work. Appending to the end is not.

## Shrinking a list

```python run
shelf.remove("rice")     # the first item equal to this
last = shelf.pop()       # take the end off, and hand it back
first = shelf.pop(0)     # or take a position
print(last, first)
print(shelf)
```

`remove` takes a value and deletes the first match — one copy, not all of
them — and raises `ValueError` if there is no match at all. `pop` takes a
position and returns what it removed.

These methods change the list where it stands and hand back `None`. So
`shelf = shelf.append("tea")` does not give you a longer shelf; it gives you
`None` and loses the shelf.

:::exercise{id="ch03-one-copy"}
Take **one** tin of beans off the shelf — the first — and print what is
left. The second tin of beans stays.

```python
shelf = ["beans", "rice", "beans", "soup"]
# your code here
print(shelf)
```

```output
['rice', 'beans', 'soup']
```

```answer
shelf = ["beans", "rice", "beans", "soup"]
shelf.remove("beans")
print(shelf)
```
:::

## Is it in there, and how many

```python run
print("soup" in shelf)
print("milk" in shelf)
print(len(shelf))
```

`in` walks the list until it finds a match, so on a list of 200,000 items it
does up to 200,000 comparisons. Fine once. Inside a loop over another long
list, it is the slowest line you will ever write, and Part II replaces it.

## The first trap: changing a list while you walk it

Nine tins, where `1` is good and `0` is past its date:

```python run
tins = [1, 1, 0, 0, 0, 1, 1, 1, 1]

for tin in tins:
    if tin == 0:
        tins.remove(tin)

print(tins)
```

A zero survived. `for` keeps a position counter, not a memory of the items: it
hands you position 0, then 1, then 2. Removing the tin at position 2 slides
everything after it down one, so the next tin — now sitting at position 2 —
never gets shown to you, because the counter has already moved to 3.

Two ways out. Walk a copy and change the original:

```python run
tins = [1, 1, 0, 0, 0, 1, 1, 1, 1]

for tin in tins[:]:
    if tin == 0:
        tins.remove(tin)

print(tins)
```

Or build the list you want and never edit the one you are reading, which is
usually the better habit and always the easier one to read:

```python run
tins = [1, 1, 0, 0, 0, 1, 1, 1, 1]
good = []

for tin in tins:
    if tin == 1:
        good.append(tin)

print(good)
```

:::exercise{id="ch03-drop-the-failures"}
The meter writes `-1` when a reading failed. Build a new list without the
`-1`s and leave the original alone. A reading of `0` is real, so it stays.

```python
readings = [4, -1, -1, 7, 0, -1, 3]
good = []
for reading in readings:
    # your code here
    ...
print(good)
print(readings)
```

```output
[4, 7, 0, 3]
[4, -1, -1, 7, 0, -1, 3]
```

```answer
readings = [4, -1, -1, 7, 0, -1, 3]
good = []
for reading in readings:
    if reading != -1:
        good.append(reading)
print(good)
print(readings)
```
:::

## The second trap: b = a does not make a copy

```python run
shelf = ["beans", "rice", "soup"]
backup = shelf

shelf.pop()
print(backup)
```

The backup lost the soup, because there was never a backup. `backup = shelf`
copies the *name*, not the list — one list with two labels on it. Chapter 2's
`is` is how you check:

```python run
shelf = ["beans", "rice", "soup"]
backup = shelf[:]            # or list(shelf)

shelf.pop()
print(backup)
print(backup is shelf)
```

Now there really are two lists, and only one of them lost a tin.

This is not a beginner's mistake you grow out of. It arrives whenever a list
is passed into a function, stored somewhere, and changed later by whoever else
is holding it.

:::figure{id="two-names-one-list"}
One list can answer to several names. A slice makes a second list.
:::

:::exercise{id="ch03-a-real-backup"}
Make `backup` a real copy, so that it still has the soup after the shelf
loses it.

```python
shelf = ["beans", "rice", "soup"]
backup = ...
shelf.pop()
print(backup)
```

```output
['beans', 'rice', 'soup']
```

```answer
shelf = ["beans", "rice", "soup"]
backup = shelf[:]
shelf.pop()
print(backup)
```
:::

## What this buys the agent

Almost everything the agent handles is a list: the files in a directory, the
lines that matched a search, the failures from a test run, the steps of a
plan. It takes slices of them — the last 40 lines of a log, the top 10 hits —
and it filters them, dropping files it has already read.

So both traps are its traps. Remove-while-looping is how a plan silently loses
a step, and nothing crashes to tell you. Aliasing is worse: the planner and
the executor end up holding one list, one of them filters it, and the other's
work disappears. Passing `steps[:]` instead of `steps` is a keystroke, and it
is the difference between a bug you can see and a bug you cannot.

## Your turn

Two challenges. The first walks through taking the last few items off a list,
where one awkward number does something you will not expect. The second hands
you a list you are not allowed to change.
