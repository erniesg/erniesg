+++
id = "title-to-slug"
kind = "challenge"
title = "A title becomes an address"
module = "slug"
figure = "text-pipeline"
support = "guided"
difficulty = 3

requires = ["ch07-strings"]
teaches = ["strings-and-text"]
tags = ["part-1", "strings", "split-join"]

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 10
timeout = 30

[tiers.edge]
xp = 15
timeout = 30

[tiers.stress]
xp = 20
timeout = 60

[tiers.perf]
xp = 5
timeout = 20
+++

:::statement
A noticeboard site makes each page's web address out of its title. *Reading the
Deal* becomes `reading-the-deal`. People paste that address to each other, so
it has no capitals or spaces.

Titles are typed by hand, so they can have spaces at the ends and doubled
spaces in the middle.

Given a title, return its slug: the words of the title, lowercased, joined by
single hyphens.
:::

:::io
input: `title`, the title as text
output: the slug as text
:::

:::constraints
- `title` is 0 to 200 characters.
- It holds only English letters, digits and spaces. No punctuation.
- Words are separated by one or more spaces, and there may be spaces at either
  end.
- The slug is lowercase, with exactly one hyphen between words and none at
  either end.
- A title with no words in it gives `""`.
:::

:::sample
| title | Output | Why |
|---|---|---|
| `"Reading the Deal"` | `"reading-the-deal"` | one space between each word |
| `"  Two   Pointers  "` | `"two-pointers"` | stray ends, doubled middle |
| `"Chapter 7"` | `"chapter-7"` | digits stay as they are |
| `"   "` | `""` | no words at all |
:::

:::figure{id="text-pipeline"}
Each step returns a new string. The title you were given does not change.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
`.split()` with nothing in the brackets is not the same as `.split(" ")`. Try
both on `"  Two   Pointers  "` and compare the two lists.
:::

:::hint{level=2}
`"-".join(words)` joins a list of strings with one hyphen between each. The
hyphen goes before the dot and the list in the brackets.
:::

:::hint{level=3}
Lowercase once: the whole title before splitting, or each word after.
`"-".join([])` is `""`, which is already the answer for a title with no words.
:::

:::solution
```python
def title_to_slug(title):
    return "-".join(title.lower().split())
```

**Read it from the inside out.** `title.lower()` makes a new, lowercase
string. `.split()` returns its words. It treats each run of spaces as one
separator and drops empty pieces, so stray spaces never reach your code.
`"-".join(...)` puts a single hyphen between the words.

**Why the empty title needs no `if`.** `"   ".split()` is `[]`, and joining an
empty list gives `""`.

**A version that nearly works.**

```python
def title_to_slug(title):
    return title.lower().replace(" ", "-")   # do not do this
```

It fails the second sample: `"  Two   Pointers  "` comes out as
`"--two---pointers--"`. `replace` turns every space into a hyphen. It does not
know that three spaces in a row are one gap. `split` does.

**Nothing was changed.** `title` is still what the caller passed in. You made
three new strings and returned the last one. Strings cannot be changed in
place.
:::
