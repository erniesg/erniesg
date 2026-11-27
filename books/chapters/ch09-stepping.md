+++
id = "ch09-stepping"
kind = "concept"
title = "Stepping through code"

teaches = ["stepping-through-code"]
requires = ["ch08-errors"]
assessed-by = ["longest-streak", "ledger-replay"]
powers = ["agent-narrows-a-failure"]
+++

A walking group keeps one step count per member per day. Someone asks for the
total over days 3 to 7 — five days — and the script answers 22,985. Add the
five numbers on paper and you get 27,385. The gap is 4,400, which is exactly
one day's count.

The program finishes without an error, but its answer is wrong.

## Print first

Here is the program.

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

Print each day and its reading inside the loop:

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

Days 3, 4, 5 and 6 go in. Day 7 never appears. `range(3, 7)` stops *before* 7,
and "days 3 to 7" meant to include it:

```python run
def total_between(first_day, last_day):
    total = 0
    for day in range(first_day, last_day + 1):
        total += steps_on(day)
    return total

print(total_between(3, 7))
```

The corrected loop prints 27,385. Printing intermediate values shows where
the calculation went wrong.

**Label debugging prints** so you can identify each value. **Remove them
when you finish** to keep the output clear.

:::exercise{id="ch09-last-two-days"}
This should total the last two days, 6610 and 5240, and it does not. Print
`day` inside the loop and click **Run** to see which days go in. Fix the
range, remove the extra print, then click **Check**.

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

Use a debugger to pause the program and inspect its variables.

Put `breakpoint()` before the code you want to inspect:

```python
def total_between(first_day, last_day):
    total = 0
    breakpoint()
    for day in range(first_day, last_day):
        total += steps_on(day)
    return total
```

At `breakpoint()`, Python pauses and opens **pdb**, its built-in debugger.
You can inspect variables and run one line at a time.

Try the practice debugger below to learn the commands. To debug your own code,
save it as `steps.py` and run it in your computer’s Terminal:

```text
python3 steps.py
```

:::debugger{id="ch09-pdb"}
This is a real session on the broken version, saved as `steps.py`.

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

The `->` marker points to the line that runs next. The loop uses `range(3, 7)`,
so it includes days 3, 4, 5 and 6, but skips day 7.

## Six commands

| Command | What it does |
|---|---|
| `n` | next — run this line, stop on the following one, step over any call |
| `s` | step — the same, but go *into* the call |
| `c` | continue — let it run until the next breakpoint or the end |
| `p expr` | print — `p day`, `p len(readings)`, `p total + steps_on(day)` |
| `l` | list — show the lines around where you are stopped |
| `q` | quit |

Pressing Enter on an empty prompt repeats the last command, which makes `n` a
single keystroke once you have typed it once.

`p` shows the value of an expression using the variables at the current line.
For example, `p day` shows the current day.

Remove `breakpoint()` when you finish debugging. In a real session, `q` stops
the program and may show a `bdb.BdbQuit` message.
:::

## When it already crashed

Now the loop is fixed and someone asks for days 3 to 12. There are only ten
days of readings.

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

The error says a list index is out of range. Use the debugger to find
the index and the length of the list.

Run the program with pdb to inspect variables after a crash:

```text
python3 -m pdb -c continue steps.py
```

When the program crashes, pdb pauses at the line that failed. You can still
inspect its variables:

:::details{title="Crash-session"}
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
:::

The top four frames are pdb's own machinery starting your program. Skip them.
Your code begins at `File "/Users/erniesg/steps.py", line 18`. The last line
names the error.

`> ... steps.py(8)steps_on()` shows where the program stopped. `p day` says 10 and `p
len(readings)` says 10, so the last valid position is 9 and day 10 does not
exist. The requested range must fit within the list.

The first `q` restarts the program at line 1. Enter `q` again to exit.

:::exercise{id="ch09-lowest-balance"}
The lowest balance should be 35, but this prints 0. Print `balance` and
`lowest` each time and click **Run**. Fix the starting value, remove the extra
prints, then click **Check**.

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

## How an agent uses this

When a test fails, the agent uses the traceback to locate the error. It can
add temporary prints to inspect values, rerun the test, and remove the prints
after fixing the bug. Print output is useful when an interactive debugger is
unavailable.

## Your turn

Fix the bugs in two challenges. The first has hints; the second does not.
