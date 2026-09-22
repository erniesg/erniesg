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
The club swims a 50-metre race. The timekeeper hands you two lists: the names
of the swimmers, and the whole seconds each of them took. The two lists line
up — the first name went with the first time, and so on.

Return the names in finishing order, fastest first. When two swimmers share a
time, the one whose name comes first alphabetically is read out first.

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
Three of these six turn up in a two-line answer.
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
key says what to order those pairs by: the time first, and the name second.
`sorted` builds a new list, so both lists you were handed are untouched — which
is half the problem statement, answered by choosing `sorted` over `.sort()`.

**Why the tuple key.** Ties are not a special case here; they are the ordinary
case with a second question attached. `(29, "ada")` against `(29, "sam")` is
compared on 29 and 29, which settles nothing, then on `"ada"` against `"sam"`,
which does. No `if` and no second pass.

Ordering by name first would be wrong, and all four public samples happen to
agree with it anyway — `key=lambda pair: (pair[0], pair[1])` passes that tier
while putting Ada ahead of Mia whatever the clock said. That is the kind of
luck a sample hands you. The edge tier does not offer it: it asks for `ada`
and `zoe` on times of 99 and 1, where the alphabet and the clock point in
opposite directions.

**Line two.** The pairs carry the times, and the timekeeper asked for names.
`[name for name, time_taken in swimmers]` unpacks each pair and keeps the half
that was asked for. Naming both halves and ignoring one is clearer than
`pair[0]`, and the name tells the next reader what the pair held.

**What it costs.** Sorting 200,000 pairs is about 3.4 million comparisons,
and it measures at about a tenth of a second. Picking the fastest remaining
swimmer 200,000 times over, which is how the stress tier's referee does it,
would be 20 billion — and that is why the referee is only ever shown races of
a handful of people.
:::
