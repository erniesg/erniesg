+++
id = "ch09-stepping"
kind = "concept"
title = "Stepping through code"
figure = "stepping-a-loop"

teaches = ["stepping-through-code"]
requires = ["ch08-errors"]
assessed-by = ["longest-streak", "ledger-replay"]
powers = ["agent-narrows-a-failure"]
+++

A walking group keeps one step count per member per day. Someone asks for the
total over days 3 to 7, five days, and the script answers 22,985. Add the
five numbers on paper and you get 27,385. The gap is 4,400, which is exactly
one day's count.

Nothing crashed, so there is no traceback to read. The number just looks
plausible.

## Print first

```python run
readings = [
    "3120", "4890", "2075", "6610", "5240",
    "3980", "7155", "4400", "2990", "5105",
]

def steps_on(day):
    return int(readings[day])

def total_between(first_day, last_day):
    total = 0
    for day in range(first_day, last_day):
        total += steps_on(day)
    return total

print(total_between(3, 7))
```

Rereading code you wrote yourself rarely shows the mistake. Instead, make the
program show what it is doing. Add one `print` inside the loop:

```python run
def total_between(first_day, last_day):
    total = 0
    for day in range(first_day, last_day):
        print("day", day, "adds", steps_on(day))
        total += steps_on(day)
    print("total", total)
    return total

total_between(3, 7)
```

Day 7 never appears. `range(3, 7)` stops *before* 7, and "days 3 to 7" meant
to include it:

```python run
def total_between(first_day, last_day):
    total = 0
    for day in range(first_day, last_day + 1):
        total += steps_on(day)
    return total

print(total_between(3, 7))
```

That is the whole technique, and it is often enough. Print the value you think
the program has, at the line where you think it has it, and compare.

**Label every print.** Five bare numbers down the screen don't say which is
which.

**Delete the prints when you are done**, or they stay in the program's output
for good.

:::exercise{id="ch09-last-two-days"}
This should total the last two days, 6610 and 5240, and it does not. Print
`day` inside the loop to see which days go in, then fix the range.

```python
readings = [3120, 4890, 2075, 6610, 5240]


def last_n_total(n):
    total = 0
    for day in range(len(readings) - n, len(readings) - 1):
        # your code here: print(day) first, then fix the line above
        total += readings[day]
    return total


print(last_n_total(2))
```

```output
11850
```

```answer
readings = [3120, 4890, 2075, 6610, 5240]


def last_n_total(n):
    total = 0
    for day in range(len(readings) - n, len(readings)):
        total += readings[day]
    return total


print(last_n_total(2))
```
:::

## Then `breakpoint()`

When you don't yet know what to print, it is easier to pause the program and
look around. Put `breakpoint()` on the line before the part you doubt:

```python
def total_between(first_day, last_day):
    total = 0
    breakpoint()
    for day in range(first_day, last_day):
        total += steps_on(day)
    return total
```

When the program reaches that line it stops and gives you a prompt from
**pdb**, the debugger built into Python. There you can look at any name and
move forward one line at a time.

This one can't run on this page. Each runnable block here goes to a Python
process in the background with no one typing at it, so `breakpoint()` would
wait for input forever. Put the code in a file and run it from a terminal:

```text
python3 steps.py
```

This is a real session on the broken version, saved as `steps.py`. Your path
will differ.

```text
> /Users/erniesg/steps.py(14)total_between()
-> for day in range(first_day, last_day):
(Pdb) l
  9  	
 10  	
 11  	def total_between(first_day, last_day):
 12  	    total = 0
 13  	    breakpoint()
 14  ->	    for day in range(first_day, last_day):
 15  	        total += steps_on(day)
 16  	    return total
 17  	
 18  	
 19  	print(total_between(3, 7))
(Pdb) p first_day, last_day
(3, 7)
(Pdb) n
> /Users/erniesg/steps.py(15)total_between()
-> total += steps_on(day)
(Pdb) s
--Call--
> /Users/erniesg/steps.py(7)steps_on()
-> def steps_on(day):
(Pdb) p day
3
(Pdb) c
22985
```

The two lines before the first `(Pdb)` say where the program stopped: line 14
of the file, inside `total_between`. The `->` line is the next line to run; it
has not run yet. `l` lists the lines around it, with `->` marking the same
line. `p first_day, last_day` prints `(3, 7)`. That is where the bug shows: the
loop is about to run over 3, 4, 5 and 6.

`n` moves on one line, into the loop body. `s` then goes *into* `steps_on`
instead of over it; `--Call--` means a new call has started. `p day` prints 3.
`c` lets the program run to the end, and it prints the wrong answer.

## Six commands

| Command | What it does |
|---|---|
| `n` | next — run this line, stop on the following one, step over any call |
| `s` | step — the same, but go *into* the call |
| `c` | continue — let it run until the next breakpoint or the end |
| `p expr` | print — `p day`, `p len(readings)`, `p total + steps_on(day)` |
| `l` | list — show the lines around where you are stopped |
| `q` | quit |

Pressing Enter on an empty prompt repeats the last command, so after one `n`
you can keep stepping with Enter.

`p` takes any expression, not just a name, and runs it at the point where the
program stopped, with the program's current values.

In a live session `q` stops the program by raising `bdb.BdbQuit`, so you may
see one last traceback on the way out. It comes from quitting, not from your
code.

Delete the `breakpoint()` line when you are done. Left in, it stops the program
wherever it runs, a server included.

:::figure{id="stepping-a-loop"}
The same session, one command at a time.
:::

## When it already crashed

The loop is fixed, and someone asks for days 3 to 12. There are only ten days
of readings.

```text
Traceback (most recent call last):
  File "/Users/erniesg/steps.py", line 18, in <module>
    print(total_between(3, 12))
          ^^^^^^^^^^^^^^^^^^^^
  File "/Users/erniesg/steps.py", line 14, in total_between
    total += steps_on(day)
             ^^^^^^^^^^^^^
  File "/Users/erniesg/steps.py", line 8, in steps_on
    return int(readings[day])
               ~~~~~~~~^^^^^
IndexError: list index out of range
```

The last line says an index ran off the end of a list. It doesn't say which
index, and by the time you read it the program has ended.

You don't need to guess where to put a `breakpoint()`. Run the file under pdb
and tell it to start by continuing:

```text
python3 -m pdb -c continue steps.py
```

When the error is raised, pdb stops in the function that raised it, with its
names still set. This is that session:

```text
Traceback (most recent call last):
  File "/Users/erniesg/.pyenv/versions/3.12.8/lib/python3.12/pdb.py", line 1959, in main
    pdb._run(target)
  File "/Users/erniesg/.pyenv/versions/3.12.8/lib/python3.12/pdb.py", line 1753, in _run
    self.run(target.code)
  File "/Users/erniesg/.pyenv/versions/3.12.8/lib/python3.12/bdb.py", line 607, in run
    exec(cmd, globals, locals)
  File "<string>", line 1, in <module>
  File "/Users/erniesg/steps.py", line 18, in <module>
    print(total_between(3, 12))
          ^^^^^^^^^^^^^^^^^^^^
  File "/Users/erniesg/steps.py", line 14, in total_between
    total += steps_on(day)
             ^^^^^^^^^^^^^
  File "/Users/erniesg/steps.py", line 8, in steps_on
    return int(readings[day])
               ~~~~~~~~^^^^^
IndexError: list index out of range
Uncaught exception. Entering post mortem debugging
Running 'cont' or 'step' will restart the program
> /Users/erniesg/steps.py(8)steps_on()
-> return int(readings[day])
(Pdb) p day
10
(Pdb) p len(readings)
10
(Pdb) q
Post mortem debugger finished. The /Users/erniesg/steps.py will be restarted
> /Users/erniesg/steps.py(1)<module>()
-> readings = [
(Pdb) q
```

The top four frames are pdb starting your program; skip them. Your code starts
at `File "/Users/erniesg/steps.py", line 18`, and the last line is the error,
as in the previous chapter.

`> ... steps.py(8)steps_on()` means pdb has stopped inside `steps_on`, where the
error was raised. `p day` and `p len(readings)` both print 10. The last valid
position is 9, so day 10 does not exist. Now you can decide whether to add
readings or narrow the range.

The first `q` restarts the program and stops at line 1. A second `q` exits.

:::exercise{id="ch09-lowest-balance"}
The lowest balance should be 35 and this prints 0. Print `balance` and
`lowest` each time round, find the wrong starting value, and fix it.

```python
payments = [20, 35, 10]
balance = 100
lowest = 0
for payment in payments:
    balance -= payment
    if balance < lowest:
        lowest = balance
    # your code here: print(balance, lowest), then fix the start
print(lowest)
```

```output
35
```

```answer
payments = [20, 35, 10]
balance = 100
lowest = balance
for payment in payments:
    balance -= payment
    if balance < lowest:
        lowest = balance
print(lowest)
```
:::

## What this buys the agent

The agent gets a failing test and a traceback. Its first job is to narrow
"this is broken" to "*this line*, with *these values*, is broken". Making the
program print what it holds does that.

So the agent adds a print, runs the test, reads the output and removes the
print. This works in a subprocess with no terminal, which is how the agent
always runs. Without a terminal it can't use pdb, so prints are what it has.
That is why this chapter started with them.

## Your turn

Both challenges give you code that is already broken, and your job is to find
where. The first has hints. The second has none; start with a print.
