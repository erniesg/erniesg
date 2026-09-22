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

The first two are easy. Saturday is where it goes wrong: 310 divided by 12 is
25.83, someone writes down 25, and 25 trays feed 300. Ten people are turned away
at the door, and nobody knows why until they are already standing there.

The arithmetic is not hard. Doing it three times by hand is where the mistake
comes from. Do it once, carefully, and give it a name.

## def gives a calculation a name

```python run
def trays_needed(portions):
    return (portions + 11) // 12


print(trays_needed(180))
print(trays_needed(240))
print(trays_needed(310))
```

Three parts worth naming. `def` starts the definition. `trays_needed` is what
you will call. `portions` is a name for whatever the caller hands over — it
exists only inside, and on the third call it holds 310.

`return` hands a value back to whoever called. The rounding up is
`(portions + 11) // 12`: adding one less than a full tray before the floor
division pushes any leftover up to the next whole tray. 310 plus 11 is 321, and
321 // 12 is 26.

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

This is the confusion that costs beginners the most hours.

```python run
def show_trays(portions):
    print((portions + 11) // 12)


answer = show_trays(310)
print(answer)
```

`show_trays` put 26 on the screen and handed back nothing. `None` is Python's
word for nothing, and it is what a function returns when you never say
`return`.

The screen is for a person. The return value is for the rest of the program. A
number that was only printed cannot be added up, compared, or passed on:

```python run
print(trays_needed(180) + trays_needed(240) + trays_needed(310))
```

Sixty-one trays across the three nights. Now the same line with the printing
version:

```python run
print(show_trays(180) + show_trays(240))
```

It printed 15 and 20 first, then refused. `unsupported operand type(s) for +:
'NoneType' and 'NoneType'` says, in plain words, that you tried to add two
nothings. Nearly every time you see it, a function printed where it should have
returned.

:::exercise{id="ch05-hand-it-back"}
The last line adds two answers together, so `seats_left` has to hand its
answer back rather than print it.

```python
def seats_left(capacity, booked):
    # your code here
    ...


print(seats_left(40, 31) + seats_left(12, 12))
```

```output
9
```

```answer
def seats_left(capacity, booked):
    return capacity - booked


print(seats_left(40, 31) + seats_left(12, 12))
```
:::

## One function, one thing

`trays_needed` does exactly one thing: portions in, trays out. That is why
three of them could be added together on one line.

It is also why it can be checked without a kitchen:

```python run
print(trays_needed(0), trays_needed(1), trays_needed(12), trays_needed(13))
```

Four awkward cases in one line. Zero portions needs no trays; one portion still
needs a whole tray; 12 fits exactly; 13 spills into a second. Checking
`show_trays` the same way means capturing what it printed, which is a great
deal more work for a worse answer.

A function that also writes a file, also prints a summary and also asks someone
a question can only be used in the one situation it was written for. A function
that takes values and returns a value can be used anywhere, including in a
test.

## Default arguments

Not every tray holds 12. Give the size a default and callers may stay quiet
when 12 is right.

```python run
def trays_for(portions, per_tray=12):
    return (portions + per_tray - 1) // per_tray


print(trays_for(310))
print(trays_for(310, 20))
print(trays_for(310, per_tray=50))
```

Arguments with defaults come after the ones without. Naming the argument at the
call — `per_tray=50` — is worth doing as soon as a call carries more than one
number; `trays_for(310, 50)` is two mystery numbers when you meet it again in a
month.

:::exercise{id="ch05-default-box"}
Give `boxes_for` a box size that defaults to 6, so all three calls work.

```python
def boxes_for(eggs):
    # your code here
    ...


print(boxes_for(13), boxes_for(13, 12), boxes_for(13, per_box=10))
```

```output
3 2 2
```

```answer
def boxes_for(eggs, per_box=6):
    return (eggs + per_box - 1) // per_box


print(boxes_for(13), boxes_for(13, 12), boxes_for(13, per_box=10))
```
:::

## The default that remembers

Now the trap. A default is worked out once, when the `def` line runs — not
once per call. With a number that makes no difference at all. With a list it
makes every difference.

```python run
def add_shortfall(short, log=[]):
    log.append(short)
    return log


print(add_shortfall(10))
print(add_shortfall(25))
```

The second call was handed no list, so it used the default — and the default is
the same list the first call appended to. It has been collecting since the
program started, and it will keep collecting.

The fix is one line, and you will meet it in every real Python codebase:

```python run
def add_shortfall(short, log=None):
    if log is None:
        log = []
    log.append(short)
    return log


print(add_shortfall(10))
print(add_shortfall(25))
```

`None` is a safe default because nothing can be appended to it, so the mistake
cannot hide. The `if` builds a fresh list per call, which is what "no list
given" ought to mean.

The rule is flat: never leave a list, a dictionary or a set as a default. Put
`None` there and build the real thing inside.

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

Assigning to a name inside a function makes a name that lives for that call
only and is thrown away when the function returns. The `per_tray` outside is
untouched — 16 trays of 20, and the 12 outside is still 12.

Reading goes the other way: a function can read a name from outside as long as
it never assigns to it. That sounds convenient and is mostly a trap. A function
that quietly reads names you cannot see in its arguments gives different
answers depending on what ran before it, which is the hardest kind of bug to
corner. Pass it what it needs.

## What this buys the agent

The agent's tools are functions: read a file, search for a name, apply a patch,
run the tests. Every one takes arguments and returns a value, because the agent
has to *use* the answer — branch on it, feed it to the next tool, put it in
front of a model. A tool that printed its result would be a tool the agent
cannot read.

One thing per function is what makes any of it testable. An `apply_patch` that
only applies a patch can be run against a hundred patches in a second. The same
code with the file writing and the logging baked in can only be checked by
running the whole agent and hoping.

The mutable default is not a curiosity here either. A tool called once per file
across 1,400 files, holding a default list, piles every file's results into one
list and hands back the ninth file's answers as the first file's. Nothing
crashes. The agent just starts editing the wrong lines.

## Your turn

Two challenges. The first is the tray sum, default argument included, and walks
you through it. The second keeps its solution shut until all four tiers are
green, and its edge tier is built out of the trap above.
