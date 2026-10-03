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
the next tin she looks at is the one that used to be fifth. She has skipped the
fourth tin, and it goes out in somebody's food parcel.

Nine things in a row is a list. This chapter covers how lists work, then two
common bugs: changing a list while walking through it, and two names that
share one list.

## Values in a row, counted from 0

```python run
tins = ["beans", "rice", "soup", "beans"]
print(tins[0])      # the first one
print(tins[2])
print(len(tins))
```

The first position is 0, not 1, so the last position is `len` minus one.
Asking for a position past the end, like `tins[4]` here, raises `IndexError`.

A minus sign counts from the end:

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

A slice is always a **new** list, and the original is unchanged. So
`readings[:]`, every position from start to end, is a short way to make a
copy. The end of the chapter uses it.

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

`append` adds one item. `extend` adds each item from another list:

```python run
a = ["beans"]
b = ["beans"]
a.append(["pasta", "oil"])    # one new item, which happens to be a list
b.extend(["pasta", "oil"])    # two new items
print(a)
print(b)
```

`insert` moves everything after the new item along by one place. On a long
list, inserting at the front takes much longer than appending to the end.

## Shrinking a list

```python run
shelf.remove("rice")     # the first item equal to this
last = shelf.pop()       # take the end off, and hand it back
first = shelf.pop(0)     # or take a position
print(last, first)
print(shelf)
```

`remove` deletes the first item equal to the value, not every copy, and
raises `ValueError` if nothing matches. `pop` takes a position and returns the
item it removed.

These methods change the list itself and return `None`. So
`shelf = shelf.append("tea")` sets `shelf` to `None`, and the list is lost.

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

`in` checks the items one by one until it finds a match, so a list of 200,000
items can take 200,000 comparisons. Inside a loop over another long list that
gets slow. Part II shows a faster way.

## The first trap: changing a list while you walk it

Nine tins, where `1` is good and `0` is past its date:

```python run
tins = [1, 1, 0, 0, 0, 1, 1, 1, 1]

for tin in tins:
    if tin == 0:
        tins.remove(tin)

print(tins)
```

A zero is still there. `for` gives you position 0, then 1, then 2. Removing
the tin at position 2 moves everything after it down one place. The next tin
is now at position 2, but the loop moves on to 3, so it skips that tin.

There are two fixes. The first walks a copy and changes the original:

```python run
tins = [1, 1, 0, 0, 0, 1, 1, 1, 1]

for tin in tins[:]:
    if tin == 0:
        tins.remove(tin)

print(tins)
```

The second builds a new list and leaves the one you are reading alone. It is
usually easier to read:

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

The backup lost the soup too. `backup = shelf` gives the same list a second
name; it does not copy it. Chapter 2's `is` shows whether two names share one
list:

```python run
shelf = ["beans", "rice", "soup"]
backup = shelf[:]            # or list(shelf)

shelf.pop()
print(backup)
print(backup is shelf)
```

Now there are two lists, and only one of them lost a tin.

The same sharing happens when a list is passed into a function or stored
somewhere: a change made through one name shows up through every other.

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

Most of what the agent handles is a list: the files in a directory, the lines
that matched a search, the failures from a test run, the steps of a plan. It
slices them, taking the last 40 lines of a log or the top 10 hits. It filters
them, dropping files it has already read.

Both bugs can happen there. Removing items while looping can drop a step from
a plan with no error. If the planner and the executor share one list and one
filters it, the other loses items too. Passing `steps[:]` instead of `steps`
gives each its own list.

## Your turn

Two challenges. The first walks through taking the last few items off a
list, including one count that needs its own case. The second
gives you a list you are not allowed to change.
