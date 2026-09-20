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
total over days 3 to 7 — five days — and the script answers 22,985. Add the
five numbers on paper and you get 27,385. The gap is 4,400, which is exactly
one day's count.

Nothing crashed. There is no traceback to read. A wrong number that looks like
a right number is the worst kind, because nothing tells you to look.

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

Reading it again will not tell you much; you already read it once and wrote it.
So stop reading and make it talk. One `print` inside the loop:

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

27,385. That is the whole technique, and most days it is enough. Print the
thing you believe, at the place you believe it, and watch the belief fail.

Two rules keep it useful. **Label every print** — five bare numbers down the
screen tell you nothing about which is which. **Delete them when you are
done**, or your program will be shouting at a log file for the next two years.

## Then `breakpoint()`

Prints get tedious when you don't yet know what to print. Then you want to
stop the program mid-flight and look around.

Put `breakpoint()` on the line before the part you doubt:

```python
def total_between(first_day, last_day):
    total = 0
    breakpoint()
    for day in range(first_day, last_day):
        total += steps_on(day)
    return total
```

When the program reaches that line it stops and hands you a prompt called
**pdb** — the debugger built into Python. From there you can look at any name
and move forward one line at a time.

**You cannot run this on this page.** Every runnable block in this book is
handed to a fresh Python in the background with nothing typing at it.
`breakpoint()` would stop and ask a question nobody can answer, and the block
would sit there until something killed it. So put the code in a file and run
it from a terminal:

```text
python3 steps.py
```

This is a real session on the broken version, with the file saved as
`steps.py`. The path will be wherever your own file is.

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

Line by line. The two lines before the first `(Pdb)` say where you are stopped:
file, line 14, inside `total_between`, and the `->` line is the line about to
run — it has not run yet. `l` prints the neighbourhood with `->` marking that
same line, which is how you get your bearings after wandering. `p first_day,
last_day` answers `(3, 7)`, which is the moment the bug was catchable: the loop
is about to run over 3, 4, 5, 6.

`n` moves on one line, into the body of the loop. `s` at that point goes *into*
`steps_on` instead of over it — `--Call--` means a new call just started. `p
day` says 3. `c` lets go of the program, which finishes and prints its wrong
answer.

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

`p` takes any expression, not just a name, and it runs that expression right
there in the middle of your program. That is the part worth remembering:
you are not reading a snapshot, you are standing inside it.

One wart: in a live session `q` stops the program by raising `bdb.BdbQuit`, so
you may see one last traceback on the way out. That one is not your bug.

And delete the `breakpoint()` line when you are done. It will stop a program
on a server just as happily as it stopped this one.

:::figure{id="stepping-a-loop"}
The same session, one command at a time.
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

Bottom line first, as always: an index ran off the end of a list. But *which*
index, and how far off? The traceback does not say, and by the time you read it
the program is gone.

You do not have to re-run it with a `breakpoint()` guessed into the right
place. Run it under pdb and tell pdb to start by just letting it go:

```text
python3 -m pdb -c continue steps.py
```

When it blows up, pdb keeps the wreck open and drops you in at the exact frame
that raised. This is that session:

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

The top four frames are pdb's own machinery starting your program. Skip them.
Your code begins at `File "/Users/erniesg/steps.py", line 18` and the last line
is the fact, exactly as in the previous chapter.

Then the useful part. `> ... steps.py(8)steps_on()` is pdb putting you inside
the frame that died, with all its names still alive. `p day` says 10 and `p
len(readings)` says 10, so the last valid position is 9 and day 10 does not
exist. Two questions, and now you know whether to widen the list or narrow the
range.

`q` at that prompt says the program "will be restarted" and offers a fresh
prompt at line 1; a second `q` leaves for good.

## What this buys the agent

The agent gets a red test and a traceback, and its first job is to turn "this
is broken" into "*this line*, with *these values*, is broken". Reading harder
does not do that. Making the program say what it holds does.

So the agent adds a print, runs the test, reads the output, removes the print.
Unglamorous and cheap, and it works in a subprocess with no terminal — which
is exactly the situation the agent is always in. When it cannot get a terminal,
post-mortem is out and prints are all there is. That is why you learned them
first.

## Your turn

Two challenges, and both ship you code that is already broken. Your job is to
find out where, which is the whole skill. The first has hints. The second has
none — a print in the right place will be faster than staring at it.
