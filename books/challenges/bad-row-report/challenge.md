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

Add up the lines that are amounts. Return a list of the ones that are not,
each with its line number. Don't stop at the first bad line; report them all
at the end.

- Line numbers start at 1 and count every entry you were given, blanks
  included.
- A line that is empty, or only spaces, is neither an amount nor a problem.
  Skip it.
- Anything else that is not a whole number of cents, and any amount below
  zero, goes in the problems list as `(line_number, the line exactly as it
  arrived)`.
- Surrounding spaces are fine: `"  42  "` is 42.

If you are given something that is not a list, raise `TypeError`. A messy row
is expected, so it gets reported. `None` from a file that failed to open is a
broken call, so it should stop there.
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
- `parse_amounts(None)` raises `TypeError`. Nothing else raises.
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
A report with line numbers is more useful than a traceback that stops at the
first bad row.
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

**Two kinds of bad line, one report.** `int("twelve")` raises and `int("-5")`
does not, so the first is caught and the second is tested. Both go in the same
list, because the person fixing the file only needs to know which line to
open.

**`enumerate(lines, start=1)` counts before the blank check.** The line number
has to count blank lines. If it doesn't, every number after the first blank is
off by one. The edge tier has a case for this.

**`continue`, not `else`.** Each bad case ends the work on that line. Using
`else` instead would nest the good path two levels deep.

**Report the line as it arrived, not stripped.** If you report `"12"` when the file holds `" 12 "`, the person goes
looking for something that is not there.

**Why `None` raises when bad rows don't.** Bad rows are expected, so they are
reported. `None` means the caller never had any lines and did not notice.
Reporting it as a bad row would hide a bug somewhere else in the program.
:::
