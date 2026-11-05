+++
id = "race-results"
kind = "challenge"
title = "Reading out the finishing order"
module = "race"
figure = "six-idioms"
support = "unaided"
difficulty = 3

requires = ["ch10-idioms"]
teaches = ["python-idioms"]
tags = ["part-1", "idioms", "sorting-by-key"]

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 10
timeout = 30

[tiers.edge]
xp = 20
timeout = 30

[tiers.stress]
xp = 25
timeout = 60

[tiers.perf]
xp = 10
timeout = 15
+++

:::statement
The club swims a 50-metre race. The timekeeper gives you two lists: the
swimmers' names, and the whole seconds each one took. The lists line up: the
first name goes with the first time, and so on.

Return the names in finishing order, fastest first. When two swimmers share a
time, the name that comes first alphabetically goes first.

Both lists you were given must come back unchanged.
:::

:::io
input: `names`, a list of text, and `seconds`, a list of whole numbers of the same length
output: a list of the names, ordered by time and then by name
:::

:::constraints
- 0 to 200,000 swimmers.
- Each time is a whole number between 0 and 1,000,000.
- Names are 1 to 20 lower-case letters. Two swimmers may share a name.
- `names` and `seconds` always have the same length.
- After your function returns, both lists must hold what they held before.
:::

:::sample
| names | seconds | Output | Why |
|---|---|---|---|
| `["mia", "sam", "ada"]` | `[31, 48, 29]` | `["ada", "mia", "sam"]` | 29, then 31, then 48 |
| `["sam", "ada"]` | `[29, 29]` | `["ada", "sam"]` | same time, so alphabetical |
| `["hal"]` | `[7]` | `["hal"]` | one swimmer |
| `[]` | `[]` | `[]` | nobody raced |
:::

:::figure{id="six-idioms"}
A two-line answer uses three of these six.
:::

:::run{starter="starter.py"}
:::

:::solution
```python
def finishing_order(names, seconds):
    swimmers = sorted(zip(names, seconds), key=lambda pair: (pair[1], pair[0]))
    return [name for name, time_taken in swimmers]
```

**Line one, read aloud.** `zip` pairs each name with its time, so
`["mia", "sam"]` and `[31, 48]` become `("mia", 31)` and `("sam", 48)`. The
key says what to order the pairs by: the time first, then the name. `sorted`
builds a new list, so both lists you were given are unchanged. Choosing
`sorted` over `.sort()` covers that part of the statement.

**Why the tuple key.** A tie needs no special code. The key just has a second
part to compare. `(29, "ada")` against `(29, "sam")` compares 29 with 29, which
is equal, then `"ada"` with `"sam"`, which decides it. No `if` and no second
pass.

Ordering by name first is wrong, but all four public samples agree with it.
`key=lambda pair: (pair[0], pair[1])` passes that tier while putting Ada ahead
of Mia whatever the times were. The edge tier catches it: it has `ada` and
`zoe` on times of 99 and 1, where alphabetical order and finishing order are
opposite.

**Line two.** The pairs hold the times, but the answer is a list of names.
`[name for name, time_taken in swimmers]` unpacks each pair and keeps the name.
Naming both parts and ignoring one is clearer than `pair[0]`, because the
names tell the next reader what the pair held.

**What it costs.** Sorting 200,000 pairs takes about 3.4 million comparisons,
which runs well inside the perf tier's 3-second limit. Picking the fastest
remaining swimmer 200,000 times over, which is how the stress tier's referee
does it, would take 20 billion. That is why the referee only checks races of
up to six swimmers.
:::
