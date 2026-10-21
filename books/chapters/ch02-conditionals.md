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
If the message says "move your car", somebody stands in a dark car park while
water rises through their hallway. This chapter is about picking the right
message.

## A question comes back True or False

```python run
level = 3.62
print(level > 3.50)
print(level == 3.62)
print(level < 2.10)
```

Six operators compare values: `>`, `<`, `>=`, `<=`, `==` for "is it the same"
and `!=` for "is it different". Each one returns a `bool`, `True` or `False`.

## if runs a block, or skips it

```python run
level = 3.62

if level >= 3.50:
    print("leave now")
```

The colon opens a block, and the indented lines below it are the block.
Python uses the indentation to see where the block ends.

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

Python checks the tests from the top and stops at the first one that is true.
A reading of 3.62 m passes all three tests. It gets "leave now" because that
test comes first. If the 2.10 test were at the top, the two tests below it
would never be reached.

`else` has no test. It runs when none of the tests above it were true. Without
it, a value that matches no test runs no branch at all, and nothing tells you.

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

Each separate `if` is checked no matter what happened above it. All three
are true at 3.62 m, so all three run, and the last one to set `message` wins.
An `elif` is only checked when every test above it was false, so the first
true test wins. Thresholds like these overlap, so the two versions give
different answers.

## and, or, not

```python run
level = 3.10
rising = False
print(level >= 3.00 and rising)   # both have to hold
print(level >= 3.00 or rising)    # either one is enough
print(not rising)                 # flips the answer over
```

`and` stops at the first false value and does not run the rest. This lets
you check that something exists and then use it, in one line:

```python run
readings = []
print(len(readings) > 0 and readings[0] > 3.0)
```

The list is empty, so `readings[0]` would be an error. The left-hand test is
false, so the right-hand side never runs. With the two tests the other way
round, the program would crash.

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

Any value can be used where Python expects `True` or `False`. Empty values
count as false.

```python run
print(bool(0), bool(12))
print(bool(""), bool("no"))
print(bool([]), bool([3.62]))
print(bool(None))
```

So `if readings:` means "if there are any readings", which is the usual way
to write it. Zero also counts as false, the same as an empty list:

```python run
level = 0.0

if level:
    print("we have a reading")
else:
    print("no reading at all")
```

The gauge reported a dry river bed, and the program treated it as a missing
reading. When zero is a real value, test for the missing case directly:
`if level is not None:`.

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

`==` asks whether two values are equal. `is` asks whether they are the same
object, with two names for it. The two usually agree, but not always:

```python run
weight = 1000
scale_says = int("1000")
print(weight == scale_says)
print(weight is scale_says)
```

The two 1000s were made separately, so they are equal but are different
objects. Use `is` only to compare with `None`, `True` and `False`, which each
exist once. Use `==` for everything else.

:::figure{id="one-door-opens"}
Only the first true test runs its branch. The tests below it are not checked.
:::

## What this buys the agent

The agent makes decisions all the time. Is this file worth opening? Did the
patch apply cleanly? Did I cause this test failure, or was it already failing?

Each decision is an `if`/`elif` chain, and the order of the tests sets the
priority. Written as separate ifs, the agent reports the mildest thing that is
true, "tests ran", when something more serious was also true: "the patch did
not apply".

Truthiness matters too. A search that returned an empty list and a search that
never ran can both be falsy. If the agent can't tell them apart, it reports
that a name appears nowhere in the repository when it never looked.

## Your turn

Two challenges. The first walks you through a chain of thresholds, with test
cases exactly on the boundaries. The second gives hints only, and its tests
include a reading of zero and a reading that never arrived.
