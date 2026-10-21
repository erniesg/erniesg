+++
id = "ch01-values"
kind = "concept"
title = "Values, names, and types"
figure = "three-kinds"

teaches = ["values-and-variables"]
requires = ["ch00-the-loop"]
assessed-by = ["shop-total", "safe-divide"]
powers = ["agent-tool-arguments"]
+++

A club runs a coach trip at 5 pounds a head. The booking form asks how many
seats and someone types 3. The screen says the total is 53.

The 5 and the 3 arrived as text, and `+` joins text end to end. As numbers
they add to 8, or multiply to 15. As text they join to 53. What `+` does
depends on the kind of value it is given.

## Values have types, and the type decides what happens

Every value in Python has a kind, called its type:

```python run
print(7)          # a whole number: int
print(7.5)        # a number with a decimal point: float
print("7")        # text that happens to look like a number: str
print(True)       # yes or no: bool
```

The type decides what an operation does:

```python run
print(2 + 3)        # 5   — numbers add
print("2" + "3")    # 23  — text joins end to end
```

`+` means "add" for numbers and "join" for text. `input()` returns text,
even when it looks like a number. Values read from files or forms often
arrive as text too.

When a number and text meet, Python raises an error instead of guessing:

```python run
try:
    print("2" + 3)
except TypeError as error:
    print("TypeError:", error)
```

`TypeError: can only concatenate str (not "int") to str` names the two types
Python was asked to mix.

To convert from one type to another, call the type by name:

```python run
print(int("2") + 3)      # 5
print("2" + str(3))      # 23
print(float("7.5") + 1)  # 8.5
```

:::exercise{id="ch01-coach-trip"}
The booking form gave you both numbers as text. Turn them into numbers and
print the total the club should charge: 15, not 53.

```python
price = "5"
seats = "3"
total = ...
print(total)
```

```output
15
```

```answer
price = "5"
seats = "3"
total = int(price) * int(seats)
print(total)
```
:::

## Names hold values

A name is a label you stick on a value:

```python run
price = 4
quantity = 3
total = price * quantity
print(total)
```

**A name holds a value, not a calculation.** `total` is 12 because
`price * quantity` was 12 when that line ran. Changing `price` afterwards does
not change `total`:

```python run
price = 4
quantity = 3
total = price * quantity
price = 10
print(total)      # still 12
```

To get the new answer, work it out again.

**A name can be given a new value at any time**, including a value of a
different type:

```python run
count = 5
count = "five"
print(count * 2)     # fivefive, not 10
```

:::exercise{id="ch01-work-it-out-again"}
A tin costs 4 and you buy 3. Then the price goes up to 6. Make `total` show
the new cost before it is printed.

```python
price = 4
quantity = 3
total = price * quantity
price = 6
# your code here
print(total)
```

```output
18
```

```answer
price = 4
quantity = 3
total = price * quantity
price = 6
total = price * quantity
print(total)
```
:::

## Integer division, and the two slashes

Python has two kinds of division, and they give different answers:

```python run
print(7 / 2)    # 3.5  — ordinary division, always a float
print(7 // 2)   # 3    — floor division, throws away the remainder
print(7 % 2)    # 1    — the remainder itself
```

`//` says how many whole ones fit, and `%` says what is left over. They are
used for splitting things into rows, telling odd from even, and wrapping around
a clock.

:::figure{id="three-kinds"}
Three kinds of value, and what the same symbol does to each.
:::

:::exercise{id="ch01-full-tables"}
310 people are coming and a table seats 12. Print how many tables are full,
then how many people are left over, on one line.

```python
people = 310
per_table = 12
full = ...
left_over = ...
print(full, left_over)
```

```output
25 10
```

```answer
people = 310
per_table = 12
full = people // per_table
left_over = people % per_table
print(full, left_over)
```
:::

## Comparing, and the difference between = and ==

One equals sign gives a name to a value. Two asks a question:

```python run
score = 7
print(score == 7)     # True  — is it seven?
print(score != 7)     # False — is it not seven?
print(score > 10)     # False
```

The answer to a question is a `bool`: `True` or `False`. In the next chapter
you pass these to `if` to choose what runs.

:::exercise{id="ch01-is-it-odd"}
Ask the question with `%` and `==`: print whether 17 is odd. The answer is a
`bool`.

```python
number = 17
is_odd = ...
print(is_odd)
```

```output
True
```

```answer
number = 17
is_odd = number % 2 == 1
print(is_odd)
```
:::

## What this buys the agent

Every tool the agent calls takes arguments, and every argument has a type. A
tool call breaks when a line number arrives as `"42"` instead of `42`, when a
path is `None` because a lookup failed, or when a count has become a float. The
agent you build spends much of its time checking that each value has the type
it expected.

## Your turn

Two challenges. The first walks you through it. The second gives hints but no
walkthrough, and its tests include more awkward cases.
