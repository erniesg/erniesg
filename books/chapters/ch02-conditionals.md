+++
id = "ch02-conditionals"
kind = "concept"
title = "Choosing with if"
figure = "one-door-opens"

teaches = ["conditionals"]
requires = ["ch01-values"]
assessed-by = ["pool-ticket-price", "fridge-alarm"]
powers = ["agent-edit-decisions"]
+++

A gauge sits in a river above a village and reports the water level every ten
minutes. Three heights matter. At 2.10 m the river is high but ordinary. At
3.00 m it covers the car park. At 3.50 m it comes through front doors.

Tonight it reads 3.62 m, and one message goes to every phone in the village.
Send "move your car" and somebody stands in a dark car park while water rises
through their hallway. One reading, one message, and the message has to be the
right one.

That choice is this chapter.

## A question comes back True or False

```python run
level = 3.62
print(level > 3.50)
print(level == 3.62)
print(level < 2.10)
```

Six operators ask questions: `>`, `<`, `>=`, `<=`, `==` for "is it the same"
and `!=` for "is it different". Each one hands back a `bool`.

## if runs a block, or skips it

```python run
level = 3.62

if level >= 3.50:
    print("leave now")
```

The colon opens a block and the indented lines are the block. Indentation is
not decoration here — it is how Python knows where the branch ends.

:::exercise{id="ch02-watch-the-river"}
The gauge reads 2.40 m. Print `watch the river` if the level is at least
2.10 m, and print nothing otherwise.

```python
level = 2.40
# your code here
```

```output
watch the river
```

```answer
level = 2.40
if level >= 2.10:
    print("watch the river")
```
:::

## elif and else: exactly one of them runs

```python run
def warning(level):
    if level >= 3.50:
        return "leave now"
    elif level >= 3.00:
        return "move your car"
    elif level >= 2.10:
        return "watch the river"
    else:
        return "nothing to do"


print(warning(3.62))
print(warning(3.00))
print(warning(0.80))
```

Python walks down the ladder and stops at the first test that is true. A
reading of 3.62 m passes all three tests, and it gets the worst message
because that rung is asked first. Put the 2.10 rung at the top instead and the
two below it can never be reached at all.

`else` is the rung with no test, and it catches everything that reached it.
Leave it out and a value that matches nothing simply falls off the bottom
having done nothing, which is a bug that makes no noise.

:::exercise{id="ch02-pool-price"}
The pool charges 2 under the age of 12, 5 from 12 to 64, and 3 from 65 up.
Fill in `price` so the four ages on the boundaries all come out right.

```python
def price(age):
    # your code here
    ...


print(price(11), price(12), price(64), price(65))
```

```output
2 5 5 3
```

```answer
def price(age):
    if age < 12:
        return 2
    elif age < 65:
        return 5
    else:
        return 3


print(price(11), price(12), price(64), price(65))
```
:::

## Why a chain of elif is not a stack of ifs

```python run
def warning_wrong(level):
    message = "nothing to do"
    if level >= 3.50:
        message = "leave now"
    if level >= 3.00:
        message = "move your car"
    if level >= 2.10:
        message = "watch the river"
    return message


print(warning_wrong(3.62))
```

The village gets "watch the river" while the water is at the door handles.

Each separate `if` is a fresh question, asked no matter what happened above.
All three are true at 3.62 m, so all three run, and the last one to write into
`message` wins. An `elif` is only asked when everything above it came back
false, so the first true rung wins instead. When your rungs overlap — and
thresholds always overlap — that difference is the whole answer.

## and, or, not

```python run
level = 3.10
rising = False
print(level >= 3.00 and rising)   # both have to hold
print(level >= 3.00 or rising)    # either one is enough
print(not rising)                 # flips the answer over
```

`and` stops as soon as it meets a false, and never looks at the rest. That is
worth knowing, because it is how you check a thing and then use it in one
line:

```python run
readings = []
print(len(readings) > 0 and readings[0] > 3.0)
```

There is no reading at position 0, so asking for one would be an error. The
left-hand test is false, so the right-hand side is never run. Put those two
tests the other way round and the program crashes.

:::exercise{id="ch02-loan-rule"}
A loan goes through when income is at least 3000 **and** debt is under 500 —
or when a guarantor has signed. Write the rule as one expression.

```python
income = 3200
debt = 650
guarantor = True
approved = ...
print(approved)
```

```output
True
```

```answer
income = 3200
debt = 650
guarantor = True
approved = (income >= 3000 and debt < 500) or guarantor
print(approved)
```
:::

## Values that answer the question by themselves

Anything can be used where Python expects a yes or no. Empty things are no.

```python run
print(bool(0), bool(12))
print(bool(""), bool("no"))
print(bool([]), bool([3.62]))
print(bool(None))
```

So `if readings:` reads as "if there are any readings at all", which is the
usual way to write it. Note what joined the falses: `0`. Zero is empty in the
same way as an empty list, and that is the trap.

```python run
level = 0.0

if level:
    print("we have a reading")
else:
    print("no reading at all")
```

The gauge reported a dry river bed, which is a fact, and the program threw it
away as a missing reading. Whenever zero is a real value, ask the question you
actually mean — `if level is not None:` — instead of the one that is shorter
to type.

:::exercise{id="ch02-zero-is-a-reading"}
`None` means the gauge sent nothing; `0.0` is a dry river bed. Return
`no reading` for `None`, and `reading: ` followed by the value for anything
else — zero included.

```python
def describe(level):
    # your code here
    ...


print(describe(0.0))
print(describe(None))
print(describe(3.2))
```

```output
reading: 0.0
no reading
reading: 3.2
```

```answer
def describe(level):
    if level is None:
        return "no reading"
    return "reading: " + str(level)


print(describe(0.0))
print(describe(None))
print(describe(3.2))
```
:::

## == compares values; is compares identity

```python run
a = [1, 2, 3]
b = [1, 2, 3]
c = a
print(a == b)    # same contents
print(a is b)    # but two separate lists
print(a is c)    # one list, two names
```

`==` asks whether two values are the same as each other. `is` asks whether
they are the same thing — one object with two labels on it. Those questions
usually agree, which is what makes the disagreement expensive:

```python run
weight = 1000
scale_says = int("1000")
print(weight == scale_says)
print(weight is scale_says)
```

Two ones-of-a-thousand, made at different moments, are two different objects
that happen to match. The rule to carry: use `is` only against `None`, `True`
and `False`, which exist exactly once each. For every other comparison you
mean `==`.

:::figure{id="one-door-opens"}
The first true rung answers, and the rest are never asked.
:::

## What this buys the agent

The agent spends its day deciding. Is this file worth opening? Did the patch
apply cleanly? Is this test failure one I caused, or was it already red?

Those decisions are ladders, and their order is the policy. Write them as
separate ifs and the agent reports the mildest thing that happens to be true —
"tests ran" — when a more serious rung above it was also true: "the patch did
not apply". Truthiness is the other half. A search that returned an empty list
and a search that was never run are both falsy, and an agent that cannot tell
them apart will confidently report that a symbol appears nowhere in the
repository.

## Your turn

Two challenges. The first walks you through a ladder of thresholds, where the
awkward cases sit exactly on the boundaries. The second gives hints only, and
its tests care about the reading that is zero and the reading that never
arrived.
