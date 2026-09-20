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

Add up the ones that are amounts, and hand back a list of the ones that are
not, each with the line number it came from. Crashing on the first bad line is
not allowed — the whole point is to get through all 312 and report at the end.

- Line numbers start at 1, counting every entry you were given, blanks
  included.
- A line that is empty, or only spaces, is neither an amount nor a problem.
  Skip it.
- Anything else that is not a whole number of cents, and any amount below
  zero, goes in the problems list as `(line_number, the line exactly as it
  arrived)`.
- Surrounding spaces are fine: `"  42  "` is 42.

One thing *is* worth raising for. Handed something that is not a list at all,
raise `TypeError`. A messy row is expected and gets reported; a caller passing
`None` because a file failed to open is a broken call, and it should stop
there.
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

**Two different ways to be bad, one report.** `int("twelve")` raises and
`int("-5")` does not, so one is caught and the other is tested. Both end up in
the same list, because the person fixing the file does not care which kind of
wrong it was — they care which line to open.

**`enumerate(lines, start=1)` before the blank check, not after.** The line
number has to count blank lines, or every number after the first blank is off
by one and points at the wrong row. That is the bug this problem is really
about, and the edge tier has a case for it.

**`continue`, not `else`.** Each bad case ends the work on that line. Reaching
for `else` here nests the good path two levels deep for no gain.

**Report the line as it arrived, not stripped.** `(3, "twelve")` is what the
file says. If you report `"12"` when the file holds `" 12 "`, the person goes
looking for something that is not there.

**Why `TypeError` for `None` is not inconsistent.** Everything else this
function meets is *expected* mess, and expected mess gets counted and reported.
`None` is not mess; it means the caller never had any lines and did not notice.
Reporting it as a bad row would hide a bug somewhere else in the program.
:::
