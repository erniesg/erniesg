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
Deal* becomes `reading-the-deal`. That address is what people paste to each
other, so it can hold no capitals and no spaces.

Titles are typed by hand, which means spaces on the ends and doubled spaces in
the middle.

Given a title, return its slug: the words of the title, lowercased, joined by
single hyphens.
:::

:::io
input: `title`, the title as text
output: the slug as text
:::

:::constraints
- `title` is 0 to 200 characters.
- It holds only English letters, digits and spaces. No punctuation arrives.
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
Each step hands back a new string. The title you were given is never touched.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
`.split()` with nothing in the brackets is not the same as `.split(" ")`. Try
both on `"  Two   Pointers  "` and read the two lists carefully.
:::

:::hint{level=2}
`"-".join(words)` glues a list of strings back together with one hyphen between
each. The glue goes on the outside, the list on the inside.
:::

:::hint{level=3}
Lowercase once — on the whole title before splitting, or on each word after.
And `"-".join([])` is `""`, which is already the answer for a title with no
words, so that case needs no code of its own.
:::

:::solution
```python
def title_to_slug(title):
    return "-".join(title.lower().split())
```

**Read it inside out.** `title.lower()` makes a new string in lowercase.
`.split()` on that returns the words, with every run of spaces treated as one
separator and the empty pieces thrown away — which is why the stray ends and
the doubled middles never reach your code. `"-".join(...)` puts a single hyphen
between what is left.

**Why the empty title needs no `if`.** `"   ".split()` is `[]`, and joining an
empty list gives `""`. The case that looks special isn't.

**The version that nearly works.**

```python
def title_to_slug(title):
    return title.lower().replace(" ", "-")   # do not do this
```

It handles the first sample and fails the second: `"  Two   Pointers  "` comes
out as `"--two---pointers--"`, because `replace` swaps every space one for one
and has no idea that three in a row were one gap. `split` knows.

**Nothing was edited.** `title` is exactly what the caller passed in, still. You
made three new strings and returned the last one; strings leave you no other
option.
:::
