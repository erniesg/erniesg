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

Nothing in that system is broken. It compared two pieces of text, the two were
different, and 38 people are not told about their appointment.

Text is where a program meets the world, and the world types badly. This
chapter is about handling that on purpose.

## A string is a sequence of characters

Everything you learned about reaching into a list works on text. Position `0`
is the first character, negative counts back from the end, and a slice takes a
run of them:

```python run
name = "readme.md"
print(name[0], name[-1])
print(name[:6])
print(name[-3:])
print(len(name), "characters")
```

`name[:6]` is "up to but not including position 6", the same half-open rule
lists use. It is worth reading `[-3:]` out loud as "the last three".

## You never edit a string

Try to change one character and Python refuses:

```python
name[0] = "R"
```

`TypeError: 'str' object does not support item assignment`. Strings are
**immutable**: fixed once made. You do not edit them, you build new ones:

```python run
capital = "R" + name[1:]
print(capital)
print(name)
```

The original is untouched, and that is the part people trip over. Every string
method hands back a *new* string and leaves yours where it was:

```python run
print(name.replace(".md", ".txt"))
print(name.upper())
print(name)
```

If you want to keep the result, give it a name. `name.replace(...)` on a line
by itself does nothing at all, and does it silently.

## Four workhorses

`strip`, `split`, `join`, `replace`. Nearly all text handling is these four in
some order:

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

Three things to take from that. `strip` only touches the two ends, never the
middle. `split` cuts on the separator you name and keeps whatever is left
either side of it, spaces included, which is why each part needed stripping.
`join` is backwards from how people expect to write it: the glue goes first,
and the list it glues must hold strings.

`split` with nothing in the brackets behaves differently, and usefully:

```python run
messy = "  two   pointers \n"
print(messy.split())
print(messy.split(" "))
```

No argument means "split on any run of whitespace and throw the empties away".
That single difference is the whole of the first challenge below.

## f-strings

Putting values into text by hand is fiddly. An `f` before the quote lets you
drop them in where they belong:

```python run
who = "grace"
visits = 3
print(f"{who} visited {visits} times")
print(f"{who.title()} averaged {visits / 7:.2f} visits a day")
```

Anything inside the braces is ordinary Python. After a colon comes formatting:
`.2f` means "a number with two digits after the point", which is how you stop a
report printing `0.42857142857142855`.

## Comparing without caring about case

Back to the clinic. Two addresses that a person would call the same:

```python run
typed = "  Ada@Example.ORG "
stored = "ada@example.org"
print(typed == stored)
print(typed.strip().lower() == stored)
```

`==` on strings is exact, character for character. When you want a human's idea
of equal, normalise both sides first — strip the ends, force one case — then
compare. Both sides. Lowercasing only the typed one leaves you with the same
bug against a stored address that came in shouting.

:::figure{id="text-pipeline"}
:::

## A character is not always a byte

One honest complication, because it bites later:

```python run
word = "café"
print(len(word), "characters")
print(len(word.encode("utf-8")), "bytes")
print(len("🙂"), len("🙂".encode("utf-8")))
```

`len` on a string counts characters. On disk and down a network those
characters are stored as bytes, and outside plain English one character often
takes two, three or four of them. So a file that is 5,000 bytes is not
necessarily 5,000 characters, and cutting a byte count in half can slice a
letter down the middle.

Work in characters in Python and this stays out of your way. It comes back when
you count what fits in a budget, where the unit is neither characters nor bytes
but tokens. Later.

## What this buys the agent

The agent's whole world is text. A source file arrives as one long string; it
splits on newlines to quote line 214, and joins a list of lines back together
after changing one of them. The model's reply comes back wrapped in code fences
that have to be stripped before anything can run. A path the model typed gets
compared against a path on disk, and on a Mac those two differ in case more
often than you would like.

Every one of those is this chapter. Immutability in particular: the agent never
edits a file in place. It builds the new text, then writes it, which is also
why it can always show you what the old text was.

## Your turn

Two challenges. The first turns titles into file names and hints as you go. The
second reads one line of a settings file, and it is fussier than it looks: the
hints stay, and the worked solution is the last thing to open.
