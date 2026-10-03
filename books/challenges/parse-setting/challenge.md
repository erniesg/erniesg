+++
id = "parse-setting"
kind = "challenge"
title = "One line of a settings file"
module = "setting"
figure = "text-pipeline"
support = "contract"
difficulty = 4

requires = ["ch07-strings"]
teaches = ["strings-and-text"]
tags = ["part-1", "strings", "parsing"]

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
timeout = 20
+++

:::statement
A nightly backup reads its settings from a file typed by hand. The line
`keep = 30` means backups are kept for 30 days. Some lines are switched off
with a `#`, some keys are in capitals, and one value contains an `=`.

Read one line and return its key and value as a pair. Return `None` if the
line holds no setting.
:::

:::io
input: `line`, one line from the file
output: a pair of the key and the value, or `None`
:::

:::constraints
- `line` is 0 to 1,000 characters. Whitespace means spaces, tabs and the line's
  own newline. It may appear at either end and around the `=`.
- Strip the line first. If what is left is empty, or starts with `#`, the line
  holds no setting.
- If there is no `=`, the line holds no setting.
- The key is everything before the **first** `=`, stripped and lowercased. If
  that is empty, the line holds no setting.
- The value is everything after the first `=`, stripped, with its case
  unchanged. It may be empty text.
- A `#` anywhere other than the start of the stripped line is an ordinary
  character. There are no comments at the end of a line.
:::

:::sample
| line | Output | Why |
|---|---|---|
| `"name = Ada"` | `("name", "Ada")` | the ordinary case |
| `"  PATH=/usr/bin  "` | `("path", "/usr/bin")` | key lowered, value untouched |
| `"greeting = a = b"` | `("greeting", "a = b")` | only the first `=` splits |
| `"retries ="` | `("retries", "")` | a key set to nothing |
| `"# retries = 3"` | `None` | switched off |
| `"= 5"` | `None` | no key to set |
:::

:::figure{id="text-pipeline"}
Strip, split, strip again. Each step makes a new string, and the caller's line
is unchanged.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Strip the whole line first. Every later rule is about the stripped text, so
`"  # off"` is a comment and `"  "` is empty.
:::

:::hint{level=2}
`"a = b = c".split("=", 1)` splits once and returns two pieces. `.split("=")`
returns three, and the value loses its own `=`.
:::

:::hint{level=3}
Four kinds of line return `None`: an empty one, one starting with `#`, one with
no `=`, and one whose key is empty after stripping. Handle all four before you
build the pair.
:::

:::hint{level=4}
Lowercase only the key. The value may be a path or a password, where case
matters. `("retries", "")` is a real answer: an empty value is not a missing
setting.
:::

:::solution
```python
def parse_setting(line):
    text = line.strip()
    if not text or text.startswith("#"):
        return None
    if "=" not in text:
        return None
    key, value = text.split("=", 1)
    key = key.strip().lower()
    if not key:
        return None
    return (key, value.strip())
```

**The order of the checks matters.** Strip first. Then return `None` for each
kind of line that holds no setting, one check at a time. Only then split, and
then check the key you got.

**Why `split("=", 1)`.** The second argument is the most splits to make.
Without it, `"greeting = a = b"` comes back as three pieces, and taking the
second one gives `" a "`. The `=` inside the value is part of the data, not
the separator.

**Why the value keeps its case.** `/Usr/Bin` and `/usr/bin` are different paths
on most systems, and a password with its case changed is a different password.
Only the key is lowercased, because `PATH` and `path` name the same setting.

**Empty is not absent.** `"retries ="` returns `("retries", "")`: the setting
exists and is set to nothing. Returning `None` would tell the caller the line
held no setting. For `keep =`, the backup would then use its default of 30 days
when someone had asked for none.

**The caller's line is unchanged.** Strings cannot be changed in place, so
each step makes a new string and `line` stays as it was.
:::
