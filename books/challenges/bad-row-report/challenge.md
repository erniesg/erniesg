+++
id = "bad-row-report"
kind = "challenge"
title = "Which line was wrong"
module = "rows"
figure = "reading-a-traceback"
support = "unaided"
difficulty = 3

requires = ["ch08-errors"]
teaches = ["errors-and-tracebacks"]
tags = ["part-1", "errors", "parsing"]

[limits]
time_seconds = 5
memory_mb = 512

[tiers.public]
xp = 15
timeout = 30

[tiers.edge]
xp = 20
timeout = 30

[tiers.stress]
xp = 25
timeout = 60

[tiers.perf]
xp = 10
timeout = 10
+++

:::statement
Someone typed 312 donations into a text file, one amount in cents per line.
Some lines are not amounts: a word, a stray decimal point, a minus sign, a
blank line where they hit Enter twice.

Add the amounts and return the other lines with their line numbers. Process all
312 lines before returning the report.

- Line numbers start at 1, counting every entry you were given, blanks
  included.
- A line that is empty, or only spaces, is neither an amount nor a problem.
  Skip it.
- Anything else that is not a whole number of cents, and any amount below
  zero, goes in the problems list as `(line_number, the line exactly as it
  arrived)`.
- Surrounding spaces are fine: `"  42  "` is 42.

Raise `TypeError` if `lines` is not a list. Bad rows are reported. `None`, for
example, means the caller did not supply any lines.
:::

:::io
input: `lines`, a list of strings
output: a pair — the total of the good lines, and a list of `(line_number, text)` for the bad ones
:::

:::constraints
- `0 <= len(lines) <= 200,000`.
- Every entry in `lines` is a string. It may contain anything.
- A good line, once its surrounding spaces are gone, is one `int()` accepts
  and whose value is not negative.
- `parse_amounts(None)` raises `TypeError`. Nothing else raises, ever.
:::

:::sample
| lines | Output | Why |
|---|---|---|
| `["1200", "850", "twelve", "3000"]` | `(5050, [(3, "twelve")])` | one word among three amounts |
| `["  42  ", "", "   ", "7"]` | `(49, [])` | spaces trimmed, blanks skipped |
| `["-5", "5"]` | `(5, [(1, "-5")])` | below zero is a problem, not a subtraction |
| `[]` | `(0, [])` | nothing to add |
| `None` | `TypeError` | that is not a file, that is a failed call |
:::

:::figure{id="reading-a-traceback"}
A report with line numbers beats a traceback that stops at the first bad row.
:::

:::run{starter="starter.py"}
:::

:::solution
```python
def parse_amounts(lines):
    if not isinstance(lines, list):
        raise TypeError(f"lines must be a list of strings, got {lines!r}")

    total = 0
    problems = []
    for number, line in enumerate(lines, start=1):
        text = line.strip()
        if not text:
            continue
        try:
            amount = int(text)
        except ValueError:
            problems.append((number, line))
            continue
        if amount < 0:
            problems.append((number, line))
            continue
        total += amount
    return (total, problems)
```

**Two bad rows, one report.** `int("twelve")` raises and `int("-5")` does not,
so the code handles them separately. Both go in the same list with their line
numbers.

**Number every line before checking for blanks.** Blank lines still count. If
you skip them first, later line numbers are wrong.

**Use `continue` after each bad row.** It moves to the next line without
nesting the good path.

**Report the original line.** The function strips spaces only to decide whether
the line is valid. It returns the text exactly as it received it.

**`None` is a caller error.** The function can report bad rows only after it
receives a list. `None` does not provide lines to process, so it raises
`TypeError`.
:::
