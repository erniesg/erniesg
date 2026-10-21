+++
id = "ch07-strings"
kind = "concept"
title = "Strings and text"
figure = "text-pipeline"

teaches = ["strings-and-text"]
requires = ["ch06-dicts-sets"]
assessed-by = ["title-to-slug", "parse-setting"]
powers = ["agent-reads-source"]
+++

A clinic emails appointment reminders the evening before. 430 people are on
tomorrow's list. The addresses were typed in from paper sign-up sheets, and 38
of them arrived with a capital letter or a space on the end: `"Ada@Example.ORG "`
where the booking system holds `"ada@example.org"`.

Nothing in the system is broken. It compared two pieces of text, they were
different, and 38 people get no reminder.

Text typed by people is messy. This chapter shows how to clean it up before
you use it.

## A string is a sequence of characters

Indexing and slicing work on text the way they work on lists. Position `0` is
the first character, negative positions count back from the end, and a slice
takes a run of characters:

```python run
name = "readme.md"
print(name[0], name[-1])
print(name[:6])
print(name[-3:])
print(len(name), "characters")
```

`name[:6]` means "up to but not including position 6", the same rule lists
use. Read `[-3:]` as "the last three".

:::exercise{id="ch07-name-and-extension"}
Print the extension without its dot, then the file name without the
extension. Slices only.

```python
name = "report.csv"
# your code here
```

```output
csv
report
```

```answer
name = "report.csv"
print(name[-3:])
print(name[:-4])
```
:::

## You never edit a string

Python won't let you change one character:

```python
name[0] = "R"
```

That raises `TypeError: 'str' object does not support item assignment`.
Strings are **immutable**: fixed once made. Instead of editing one, you build a
new one:

```python run
capital = "R" + name[1:]
print(capital)
print(name)
```

The original is unchanged. String methods work the same way: each returns a
*new* string and leaves the original alone:

```python run
print(name.replace(".md", ".txt"))
print(name.upper())
print(name)
```

To keep the result, assign it to a name. `name.replace(...)` on a line by
itself changes nothing.

## Four workhorses

Most text handling uses four methods: `strip`, `split`, `join` and
`replace`:

```python run
line = "  rice , beans ,  salt  "
print(line.strip())
parts = line.split(",")
print(parts)
items = []
for part in parts:
    items.append(part.strip())
print(items)
print(" + ".join(items))
```

`strip` removes whitespace from the two ends only, never the middle. `split`
cuts on the separator you name and keeps everything either side of it, spaces
included, so each part needed stripping. `join` is called on the glue, not the
list: the glue goes first, and the list must hold strings.

`split` with nothing in the brackets works differently:

```python run
messy = "  two   pointers \n"
print(messy.split())
print(messy.split(" "))
```

With no argument, `split` cuts on any run of whitespace and drops the empty
strings. The first challenge below is built on this difference.

:::exercise{id="ch07-tidy-the-order"}
Split the order on commas, strip each item, and print them joined with
` | `.

```python
line = " eggs,milk , bread ,tea"
# your code here
```

```output
eggs | milk | bread | tea
```

```answer
line = " eggs,milk , bread ,tea"
items = []
for part in line.split(","):
    items.append(part.strip())
print(" | ".join(items))
```
:::

## f-strings

An `f` before the quote makes an f-string. Values in braces are placed into
the text:

```python run
who = "grace"
visits = 3
print(f"{who} visited {visits} times")
print(f"{who.title()} averaged {visits / 7:.2f} visits a day")
```

Anything inside the braces is ordinary Python. After a colon comes formatting.
`.2f` means "a number with two digits after the point", so the report shows
`0.43`, not `0.42857142857142855`.

:::exercise{id="ch07-receipt-line"}
Print one receipt line with an f-string, the price to two decimal places:
`3 x rice = 3.60`.

```python
item = "rice"
quantity = 3
price = 1.2
# your code here
```

```output
3 x rice = 3.60
```

```answer
item = "rice"
quantity = 3
price = 1.2
print(f"{quantity} x {item} = {quantity * price:.2f}")
```
:::

## Comparing without caring about case

Back to the clinic. A person would call these two addresses the same:

```python run
typed = "  Ada@Example.ORG "
stored = "ada@example.org"
print(typed == stored)
print(typed.strip().lower() == stored)
```

`==` on strings compares character for character. To compare the way a person
would, normalise first: strip the ends and force one case. Do it to both
sides, since a stored address can have capitals too.

:::figure{id="text-pipeline"}
:::

:::exercise{id="ch07-same-address"}
Count how many typed addresses match the stored one once you strip the ends
and force one case.

```python
typed = ["Ada@Example.org ", "ada@example.org", " ADA@EXAMPLE.ORG", "ada@example.com"]
stored = "ada@example.org"
matches = 0
# your code here
print(matches)
```

```output
3
```

```answer
typed = ["Ada@Example.org ", "ada@example.org", " ADA@EXAMPLE.ORG", "ada@example.com"]
stored = "ada@example.org"
matches = 0
for address in typed:
    if address.strip().lower() == stored:
        matches += 1
print(matches)
```
:::

## A character is not always a byte

Characters and bytes are not the same thing:

```python run
word = "café"
print(len(word), "characters")
print(len(word.encode("utf-8")), "bytes")
print(len("🙂"), len("🙂".encode("utf-8")))
```

`len` on a string counts characters. On disk and over a network, characters
are stored as bytes. Outside plain English, one character often takes two,
three or four bytes. So a 5,000-byte file is not necessarily 5,000 characters,
and cutting a byte count in half can split a character in two.

If you work in characters in Python, this doesn't come up. It returns later,
when you measure what fits in a budget in tokens, which are neither characters
nor bytes.

:::exercise{id="ch07-reads-both-ways"}
A word reads the same both ways if it equals itself reversed. Ignoring case,
print whether each word does. (`word[::-1]` is the word backwards.)

```python
def same_both_ways(word):
    # your code here
    ...


print(same_both_ways("Level"))
print(same_both_ways("river"))
```

```output
True
False
```

```answer
def same_both_ways(word):
    word = word.lower()
    return word == word[::-1]


print(same_both_ways("Level"))
print(same_both_ways("river"))
```
:::

## What this buys the agent

The agent works almost entirely with text. A source file arrives as one long
string. The agent splits it on newlines to quote line 214, and joins the lines
back together after changing one. The model's reply comes wrapped in code
fences, which have to be stripped before the code can run. A path the model
typed is compared with a path on disk, and on a Mac the two can differ in case.

The agent also never edits a file in place. It builds the new text, then
writes it, so it can always show you the old text.

## Your turn

Two challenges. The first turns titles into file names, with hints as you go.
The second reads one line of a settings file. It has hints; try to finish
before opening the worked solution.
