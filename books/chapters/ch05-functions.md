+++
id = "ch05-functions"
kind = "concept"
title = "Functions"
figure = "what-comes-back"

teaches = ["functions"]
requires = ["ch04-loops"]
assessed-by = ["tray-count", "shortfall-log"]
powers = ["agent-tool-calls"]
+++

A community kitchen serves meals out of donated trays. A tray holds 12
portions and has to be ordered whole. Tonight they expect 180 people, tomorrow
240, and Saturday 310.

Saturday is where it goes wrong. 310 divided by 12 is 25.83, someone writes
down 25, and 25 trays feed only 300 people. Ten are turned away.

The calculation is easy; doing it by hand three times is what lets the
mistake in. Write it once and give it a name.

## def gives a calculation a name

```python run
def trays_needed(portions):
    return (portions + 11) // 12


print(trays_needed(180))
print(trays_needed(240))
print(trays_needed(310))
```

`def` starts the definition and `trays_needed` is its name. `portions` holds
whatever the caller passes in; on the third call it is 310. It exists only
inside the function.

`return` hands a value back to the caller. `(portions + 11) // 12` rounds up:
adding 11, one less than a full tray, pushes any leftover into the next tray.
310 + 11 is 321, and 321 // 12 is 26.

:::exercise{id="ch05-egg-boxes"}
A box holds 6 eggs and is sold whole. Write `boxes_needed` so that it rounds
up — and check the four awkward sizes below.

```python
def boxes_needed(eggs):
    # your code here
    ...


print(boxes_needed(0), boxes_needed(1), boxes_needed(6), boxes_needed(7))
```

```output
0 1 1 2
```

```answer
def boxes_needed(eggs):
    return (eggs + 5) // 6


print(boxes_needed(0), boxes_needed(1), boxes_needed(6), boxes_needed(7))
```
:::

## Returning is not printing

```python run
def show_trays(portions):
    print((portions + 11) // 12)


answer = show_trays(310)
print(answer)
```

`show_trays` put 26 on the screen and returned nothing. A function without
`return` hands back `None`, Python's value for nothing.

Printing shows a value to a person. Returning gives it to the rest of the
program, which can then add it, compare it or pass it on:

```python run
print(trays_needed(180) + trays_needed(240) + trays_needed(310))
```

61 trays over three nights. The same line with the printing version:

```python run
print(show_trays(180) + show_trays(240))
```

It prints 15 and 20, then fails: `unsupported operand type(s) for +:
'NoneType' and 'NoneType'` means you tried to add two `None`s. When you see
this error, look for a function that prints instead of returning.

:::exercise{id="ch05-hand-it-back"}
The last line adds two answers together, so `seats_left` has to hand its
answer back rather than print it.

```python
def seats_left(capacity, booked):
    # your code here
    ...


print(seats_left(40, 31) + seats_left(30, 12))
```

```output
27
```

```answer
def seats_left(capacity, booked):
    return capacity - booked


print(seats_left(40, 31) + seats_left(30, 12))
```
:::

## One function, one thing

`trays_needed` does one thing: portions in, trays out. That is why three calls
could be added on one line, and why it can be checked on its own:

```python run
print(trays_needed(0), trays_needed(1), trays_needed(12), trays_needed(13))
```

Zero portions needs no trays, one needs a whole tray, 12 fits exactly and 13
needs a second. To check `show_trays` you would have to capture what it printed.

A function that also writes a file or prints a summary only fits the one place
it was written for. A function that takes values and returns one fits anywhere,
including a test.

## Default arguments

So far every tray holds 12. Some hold 20 or 50, so the size should be
something the caller can pass in. But most trays do hold 12, and making every
caller type 12 is noise. A default does both: `per_tray=12` in the `def` line
means "use 12 unless the caller hands over a different number".

```python run
def trays_for(portions, per_tray=12):
    return (portions + per_tray - 1) // per_tray


print(trays_for(310))
print(trays_for(310, 20))
print(trays_for(310, per_tray=50))
```

Two rules come with defaults. First, a parameter with a default goes after the
ones without: `def trays_for(per_tray=12, portions)` is a `SyntaxError`, because
the values a caller hands over fill the parameters from the left.

Second, when a call passes the optional value, it can say which parameter the
value is for. `trays_for(310, 50)` and `trays_for(310, per_tray=50)` give the
same answer, but only the second tells a reader what 50 means without looking
up the function.

:::exercise{id="ch05-default-box"}
Give `boxes_for` a box size that defaults to 6, so all three calls work.

```python
def boxes_for(eggs):
    # your code here
    ...


print(boxes_for(12), boxes_for(12, 12), boxes_for(12, per_box=10))
```

```output
2 1 2
```

```answer
def boxes_for(eggs, per_box=6):
    return (eggs + per_box - 1) // per_box


print(boxes_for(12), boxes_for(12, 12), boxes_for(12, per_box=10))
```
:::

## The default that remembers

A default is worked out once, when the `def` line runs, not on every call. For
a number that doesn't matter. For a list it does:

```python run
def add_shortfall(short, log=[]):
    log.append(short)
    return log


print(add_shortfall(10))
print(add_shortfall(25))
```

The second call got no list, so it used the default, which is the same list
the first call appended to. Every call that leaves out `log` shares it.

The usual fix:

```python run
def add_shortfall(short, log=None):
    if log is None:
        log = []
    log.append(short)
    return log


print(add_shortfall(10))
print(add_shortfall(25))
```

The default is now `None`, and the `if` builds a new list on each call that
doesn't pass one. Do the same for any list, dictionary or set default.

:::figure{id="what-comes-back"}
The two ends of the deal, and the two places people get it wrong.
:::

:::exercise{id="ch05-fresh-basket"}
Each call that is not handed a basket should start with an empty one. Use
the `None` default from above.

```python
def add_item(item, basket=None):
    # your code here
    ...


print(add_item("rice"))
print(add_item("oil"))
```

```output
['rice']
['oil']
```

```answer
def add_item(item, basket=None):
    if basket is None:
        basket = []
    basket.append(item)
    return basket


print(add_item("rice"))
print(add_item("oil"))
```
:::

## Names inside a function stay inside

```python run
per_tray = 12


def trays_for_twenty(portions):
    per_tray = 20
    return (portions + per_tray - 1) // per_tray


print(trays_for_twenty(310))
print(per_tray)
```

A name assigned inside a function belongs to that call and disappears when it
returns. The function used trays of 20; the `per_tray` outside is still 12.

A function can also read a name from outside, if it never assigns to it. But
then its answer depends on code you can't see in the call. Passing values as
arguments keeps everything the function uses in view.

## What this buys the agent

The agent's tools are functions: read a file, search, apply a patch, run the
tests. Each returns a value, because the agent has to use the answer: branch on
it, pass it to the next tool, show it to the model. A printed result is one the
agent can't read.

Doing one thing also makes each tool testable on its own. An `apply_patch` that
only applies patches can be checked against a hundred patches in a second.

The shared default matters here too. A tool with a list default, called once
per file, collects every file's results in one list, and the agent ends up
editing lines from the wrong file.

## Your turn

Two challenges. The first is the tray sum with a default argument, and walks
you through it. In the second, try to finish before reading the solution; its
edge tests use the shared-default bug above.
