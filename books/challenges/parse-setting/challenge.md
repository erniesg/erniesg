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
A nightly backup reads its settings from a file someone typed by hand. One line
says `keep = 30`, and that 30 is how many days of backups survive. Other lines
are switched off with a `#`, a few have the key in capitals, and one value is a
greeting that contains an `=` of its own.

Read one line and say what setting it holds.

Return the key and the value as a pair. Return `None` for a line that holds no
setting at all.
:::

:::io
input: `line`, one line from the file
output: a pair — the key and the value — or `None`
:::

:::constraints
- `line` is 0 to 1,000 characters. Whitespace means spaces, tabs and the line's
  own newline, and it may sit at either end and around the `=`.
- Strip the line first. If what is left is empty, or starts with `#`, the line
  holds no setting.
- If there is no `=`, the line holds no setting.
- The key is everything before the **first** `=`, stripped, lowercased. If that
  is empty, the line holds no setting.
- The value is everything after the first `=`, stripped, with its case left
  exactly as it came. It may be empty text.
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
Strip, cut, strip again. Four new strings and the caller's line untouched.
:::

:::run{starter="starter.py"}
:::

:::hint{level=1}
Strip the whole line before anything else. Every rule after that is about what
is left, which is why `"  # off"` is a comment and `"  "` is nothing.
:::

:::hint{level=2}
`"a = b = c".split("=", 1)` cuts once and hands back exactly two pieces.
`.split("=")` hands back three, and the value loses the `=` that belonged to
it.
:::

:::hint{level=3}
Four different lines all answer `None`: the empty one, the one starting with
`#`, the one with no `=`, and the one whose key is empty once stripped. Settle
all four before you build the pair.
:::

:::hint{level=4}
Lowercase the key only. The value is somebody's path or password, and changing
its case changes what it means. `("retries", "")` is a real answer — empty is
not the same as absent.
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

**The order of the checks is the whole problem.** Strip first, because every
rule below is about the stripped text. Then get rid of the lines that hold
nothing, one reason at a time. Only then split, and only then look at the key
you actually got.

**Why `split("=", 1)`.** The second argument is the number of cuts. Without it,
`"greeting = a = b"` comes back as three pieces and the natural next move —
taking the second one — hands you `" a "`. The `=` inside a value is somebody's
data, not your separator.

**Why the value keeps its case.** `/Usr/Bin` and `/usr/bin` are different paths
on most systems, and a password is worse. Lowercasing is for the key, where a
human writing `PATH` and a human writing `path` mean the same thing.

**Empty is not absent.** `"retries ="` returns `("retries", "")`, which says
*this setting exists and is set to nothing*. Returning `None` there would tell
the caller the line was blank, and the backup would quietly keep its default of
30 days when somebody had asked for none.

**Three new strings, one original.** `line` is unchanged when you return. That
is not politeness, it is the only thing a string will let you do.
:::
