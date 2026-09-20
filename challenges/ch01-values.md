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

Nothing in the computer went wrong. The 5 and the 3 arrived as text, and
joining text end to end is exactly what `+` does to text. As numbers they add
to 8, or multiply to 15. As text they join to 53. One symbol, three answers,
and the difference is what kind of thing you handed it.

## Values have types, and the type decides what happens

Type a value into Python and it has a kind:

```python run
print(7)          # a whole number: int
print(7.5)        # a number with a decimal point: float
print("7")        # text that happens to look like a number: str
print(True)       # yes or no: bool
```

The type is not decoration. It decides what an operation *means*:

```python run
print(2 + 3)        # 5   — numbers add
print("2" + "3")    # 23  — text joins end to end
```

Nothing is broken in the second line. `+` means "add" for numbers and "join"
for text, and Python cannot read your mind about which you wanted. Most
beginner bugs are this: a value is text when you thought it was a number,
usually because it came from a file, a form, or `input()`.

When the two kinds meet, Python refuses rather than guessing:

```python run
try:
    print("2" + 3)
except TypeError as error:
    print("TypeError:", error)
```

Read that error. `TypeError: can only concatenate str (not "int") to str` is
Python telling you exactly which two kinds it was asked to mix. You will see
this message for the rest of your life, so it is worth recognising now.

To cross between kinds, say so:

```python run
print(int("2") + 3)      # 5
print("2" + str(3))      # 23
print(float("7.5") + 1)  # 8.5
```

## Names hold values

A name is a label you stick on a value:

```python run
price = 4
quantity = 3
total = price * quantity
print(total)
```

Two things people expect that are not true.

**A name is not a box that remembers arithmetic.** `total` is 12 because
`price * quantity` was 12 *at that moment*. Change `price` afterwards and
`total` does not move:

```python run
price = 4
quantity = 3
total = price * quantity
price = 10
print(total)      # still 12
```

If you want the new answer, work it out again. This catches everyone once.

**A name can be re-pointed at any time**, including at a different kind of
value. That is legal and occasionally the bug:

```python run
count = 5
count = "five"
print(count * 2)     # fivefive, not 10
```

## Integer division, and the two slashes

Two kinds of division exist, and choosing the wrong one quietly changes your
answer:

```python run
print(7 / 2)    # 3.5  — ordinary division, always a float
print(7 // 2)   # 3    — floor division, throws away the remainder
print(7 % 2)    # 1    — the remainder itself
```

`//` and `%` come back constantly: splitting things into rows, telling odd from
even, wrapping around a clock. They are not exotic; they are how you say "how
many whole ones fit, and what is left over".

:::figure{id="three-kinds"}
Three kinds of value, and what the same symbol does to each.
:::

## Comparing, and the difference between = and ==

One equals sign gives a name to a value. Two asks a question:

```python run
score = 7
print(score == 7)     # True  — is it seven?
print(score != 7)     # False — is it not seven?
print(score > 10)     # False
```

The answer to a question is a `bool`: `True` or `False`. You will hand those to
`if` in the next chapter, and the whole of branching rests on them.

## What this buys the agent

Every tool the agent calls takes arguments, and every argument has a type. A
line number that arrives as `"42"` instead of `42`, a path that is `None`
because a lookup failed, a count that silently became a float — that is where
a tool call breaks. The agent you build spends a lot of its life checking that
what arrived is what it expected, which is this chapter, repeated at scale.

## Your turn

Two challenges. The first walks you through it. The second gives you hints but
no walkthrough, and its tests are less forgiving about the awkward cases.
