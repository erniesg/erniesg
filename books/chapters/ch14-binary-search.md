+++
id = "ch14-binary-search"
kind = "concept"
title = "Binary search"
figure = "halving-the-log"

teaches = ["binary-search"]
requires = ["ch13-sorting"]
assessed-by = ["next-train-home", "cut-them-all-the-same"]
powers = ["agent-context-budget"]
+++

At 03:14 last night a payment site stopped taking cards. By nine this morning
the engineer on call has to say what happened in the minute before it went
down. The evidence is one file: 2,400,000 lines, one per request, written in
the order the requests arrived.

She opens the file halfway, not at the top. The line there is stamped
11:59:59. That is too late, and every line below it is later still, so she can
ignore that half. Halfway into what is left, the line reads 05:59:59. Still too
late, so that half goes too. The third look lands on 02:59:59. That is too
early, so this time the half *above* goes.

After 22 looks she is on the line she wanted.

```python run
LINES = 2_400_000


def time_on(line):
    """This log covers one day evenly, so line 0 is stamped 00:00:00."""
    seconds = line * 86_400 // LINES
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


looks = 0
low, high = 0, LINES - 1
while low <= high:
    mid = (low + high) // 2
    looks += 1
    if time_on(mid) < "03:14:00":
        low = mid + 1
    else:
        high = mid - 1

print("lines in the file: ", f"{LINES:,}")
print("lines she read:    ", looks)
print("first line at 03:14:", f"{low:,}", time_on(low))
```

For a person reading the file, 22 looks instead of 2,400,000 is a minute
instead of a morning. For a program, one scan of 2.4 million lines takes about
a quarter of a second. That is small until the same question is asked for each
of 20,000 alerts. Then it adds up to over 80 minutes.

(The timestamps are compared with `<` as text. This works because every field
is padded to the same width, so comparing `"03:14:00"` and `"11:59:59"`
character by character gives the same order as the clock. Without the leading
zeros it would not.)

## Sorted is not a detail, it is the whole trick

Here is the search on its own, over a list:

```python run
def position_of(values, wanted):
    low, high = 0, len(values) - 1
    while low <= high:
        mid = (low + high) // 2
        if values[mid] == wanted:
            return mid
        if values[mid] < wanted:
            low = mid + 1
        else:
            high = mid - 1
    return -1


departures = [612, 645, 700, 733, 801, 845]
print(position_of(departures, 733))   # 3
print(position_of(departures, 650))   # -1, no train at 06:50
```

Each step drops half the list after one comparison. That only works because
the list is in order. If `values[mid]` is smaller than what you want, then
*everything to the left of it* is smaller too, without looking.

On an unsorted list that reasoning no longer holds:

```python run
shuffled = [733, 612, 845, 700, 801, 645]
print("801 is in the list:", 801 in shuffled)
print("halving finds it at:", position_of(shuffled, 801))
```

It returns -1 for a value at index 4, and raises no error. On unsorted data a
binary search gives a wrong answer rather than failing. So sort the input
first. Sorting costs more than a search (see the last chapter), so sort once
and search many times.

## Three names, and only one of them is interesting

`low` and `high` are the ends of the part you have not ruled out yet. `mid` is
halfway between them. Each turn of the loop does three things:

1. Look at `mid`.
2. Decide which half cannot contain the answer.
3. Move `low` or `high` past `mid` so that half is gone.

Step 3 is where binary search goes right or wrong. Moving the wrong bound
gives a wrong answer. Moving it by the wrong amount gives no answer at all.

:::figure{id="halving-the-log"}
:::

In the last row of the figure, six looks take 2,400,000 lines down to 37,499.
Doubling the file adds one look. A hundred million lines would take 27.

## The off-by-one that never finishes

Here is the loop with `low = mid` instead of `low = mid + 1`. It has a counter
to stop it, because otherwise it would run forever:

```python run
values = [1, 3, 5, 7, 9]
low, high = 0, len(values) - 1
steps = 0

while low <= high and steps < 6:
    steps += 1
    mid = (low + high) // 2
    if values[mid] < 4:
        low = mid          # should be mid + 1
    else:
        high = mid - 1
    print(f"step {steps}: mid={mid} -> low={low} high={high}")

print("stopped by the counter, not by the loop" if steps == 6 else "finished")
```

From step 2 on, `low=0` and `high=1`, so `mid` is 0. `values[0]` is 1, which
is less than 4, so `low` becomes 0. It was already 0. Nothing changed, so every
later turn is the same.

The rule: **every turn must make the window smaller.** `mid` has already been
checked, so it must end up outside the window: `low = mid + 1` or
`high = mid - 1`. If a loop like this does not end, print `low`, `high` and
`mid` each turn, as above. The values that stop changing show which line to
fix.

## When it is not there, you still want to know where

Often `-1` is not the answer you need. The engineer wants the first line at or
after 03:14:00, whether or not one is stamped exactly that. There is no train
at 06:50, so you want the next one.

The loop already finds this. When it ends, `low` is where the missing value
would go:

```python run
def insertion_point(values, wanted):
    low, high = 0, len(values) - 1
    while low <= high:
        mid = (low + high) // 2
        if values[mid] < wanted:
            low = mid + 1
        else:
            high = mid - 1
    return low


for wanted in (600, 650, 733, 900):
    where = insertion_point(departures, wanted)
    after = departures[where] if where < len(departures) else "nothing later"
    print(f"arrive {wanted}: slots in at {where}, next train {after}")
```

This version has no `== wanted` test, so it never stops early. It always
narrows the window down to nothing, and in return it answers the more useful
question.

Asking for 733, which *is* in the list, gives the position of 733 itself,
because the first value at or after 733 is 733.

When there is nothing later, `low` comes back equal to `len(values)`, which is
not a valid index. The code has to check for that before indexing, as the
`where < len(departures)` test does above. Without it, a time after 845 raises
an `IndexError`.

:::exercise{id="ch14-last-train-before"}
The mirror image of the insertion point: return the position of the **last**
departure at or before `wanted`, or -1 if there is none. Halve; don't scan.

```python
departures = [612, 645, 700, 733, 801, 845]


def last_at_or_before(values, wanted):
    # your code here
    ...


print(last_at_or_before(departures, 650))
print(last_at_or_before(departures, 600))
print(last_at_or_before(departures, 733))
print(last_at_or_before(departures, 900))
```

```output
1
-1
3
5
```

```answer
departures = [612, 645, 700, 733, 801, 845]


def last_at_or_before(values, wanted):
    low, high = 0, len(values) - 1
    while low <= high:
        mid = (low + high) // 2
        if values[mid] <= wanted:
            low = mid + 1
        else:
            high = mid - 1
    return high


print(last_at_or_before(departures, 650))
print(last_at_or_before(departures, 600))
print(last_at_or_before(departures, 733))
print(last_at_or_before(departures, 900))
```
:::

## The standard library already has it

Writing the loop by hand once is worth it, because later in this chapter you
need it for something that is not a list. For a list, use `bisect`:

```python run
import bisect

print(bisect.bisect_left(departures, 650))    # where 650 would go
print(bisect.bisect_left(departures, 733))    # first slot holding 733
print(bisect.bisect_right(departures, 733))   # first slot after 733

running = [612, 700, 801]
bisect.insort(running, 733)
print(running)                                # inserted in order
```

`bisect_left` and `bisect_right` differ only when the value is already in the
list. `bisect_left` gives the position of the first copy. `bisect_right` gives
the position just after the last copy. When the value is not there, both give
the insertion point. `insort` finds the place and inserts in one call, so a
list stays sorted as it grows.

`bisect` only searches a list. To search something you cannot build a list of,
you write the loop yourself. It also compares whole items. To search a list of
rows by one field, pass `key=`, or keep a separate sorted list of that field.

:::exercise{id="ch14-count-in-window"}
With `bisect`, count the trains leaving from 700 to 830, both ends
included.

```python
import bisect

departures = [612, 645, 700, 733, 801, 845]
# your code here
```

```output
3
```

```answer
import bisect

departures = [612, 645, 700, 733, 801, 845]
print(bisect.bisect_right(departures, 830) - bisect.bisect_left(departures, 700))
```
:::

## Binary search on the answer

Someone has an exam in 14 days and a textbook of 42 chapters and 1,363 pages.
She reads the chapters in order and does not stop in the middle of one, so each
day covers some whole chapters in a row. She wants the smallest daily page cap
that still finishes in time. Too low and she runs out of days. Too high and she
reads more than she needs to every night.

There is no list to search. The answer is a number between 52 and 1,363. 52 is
the longest chapter, which has to fit in some day. 1,363 is the whole book in
one day. That is 1,312 candidates.

Start with a question that is easy to answer: given a cap, how many days does
it take?

```python run
pages = [20, 47, 29, 31, 30, 32, 18, 42, 33, 43, 39, 39, 21, 30,
         28, 34, 36, 30, 37, 47, 23, 24, 49, 31, 24, 14, 18, 21,
         52, 35, 15, 19, 31, 27, 38, 39, 51, 42, 52, 20, 21, 51]


def days_needed(cap):
    days, today = 1, 0
    for chapter in pages:
        if today + chapter > cap:      # does not fit, so start tomorrow
            days += 1
            today = 0
        today += chapter
    return days


for cap in (60, 80, 100, 110, 115, 120, 140):
    days = days_needed(cap)
    print(f"cap {cap:>4} pages: {days:>2} days  "
          f"{'fits' if days <= 14 else 'too slow'}")
```

In the last column, once a cap fits, every larger cap fits too. More pages a
day can never mean more days. A yes-or-no answer that switches only once like
this is called *monotonic*.

So the answers form two blocks, all "too slow" then all "fits", and you are
looking for the boundary between them. That is something you can find by
halving.

```python run
low, high = max(pages), sum(pages)
best = high
probes = 0

while low <= high:
    mid = (low + high) // 2
    probes += 1
    if days_needed(mid) <= 14:
        best = mid             # this cap works; try a stingier one
        high = mid - 1
    else:
        low = mid + 1          # not enough; be more generous

print("smallest cap that finishes in 14 days:", best)
print("caps she could have tried:", sum(pages) - max(pages) + 1)
print("caps she actually tried:  ", probes)
```

It is the same loop: `low`, `high`, `mid`, and one bound moves past `mid` each
turn. Two things changed. There is no list, so `mid` is a candidate *answer*,
not a position. And the comparison with `values[mid]` is replaced by your own
question, `days_needed(mid) <= 14`. The loop finds the boundary of whatever
that question asks, so the question has to be right.

`best` records each cap that works before the loop tries a smaller one. When
the window closes, `best` holds the smallest cap that answered yes.

`low` starts at `max(pages)`, not at 1, and this is needed for a correct
answer. With a cap of 30, `days_needed` still returns a number: it puts the
52-page chapter in a day of its own, over the cap. The test could then say a
cap fits when no schedule can keep it. Start the range where the question
gives true answers.

The yeses can also come first. Ask for the *latest* minute she can leave the
house and still reach the exam at nine, and the column reads yes, yes, yes, no,
no: leaving early always works, leaving late never does. The loop is the same,
with `best`, but a yes moves `low` up instead of `high` down. Write the column
out for four or five candidates before writing the code. Which way it runs
decides which bound moves.

You can binary search any range of candidate answers where a yes-or-no
question has all its yeses on one side. Here that took 10 calls to
`days_needed` instead of 1,312.

:::exercise{id="ch14-smallest-square"}
Search the answer: the smallest whole number `x` with `x * x >= n`. Write
the yes-or-no column out for a few candidates first, then halve.

```python
def smallest_root(n):
    # your code here
    ...


print(smallest_root(1_000_000))
print(smallest_root(10))
print(smallest_root(1))
```

```output
1000
4
1
```

```answer
def smallest_root(n):
    low, high = 1, n
    best = n
    while low <= high:
        mid = (low + high) // 2
        if mid * mid >= n:
            best = mid
            high = mid - 1
        else:
            low = mid + 1
    return best


print(smallest_root(1_000_000))
print(smallest_root(10))
print(smallest_root(1))
```
:::

## What this buys the agent

The agent has just searched the repository and is holding 380 snippets, best
first. The model it is about to call has room for 100,000 tokens of them. How
many does it send?

Adding up the 380 snippet sizes does not give the answer. The snippets are
rendered into one prompt, with file headers, separators and a template around
them. The count that matters is the tokens in that finished prompt. So each
check means building the whole prompt and running a tokeniser over it. Doing
that once for each of 380 candidates is a delay a person notices.

But "do the top k snippets fit in 100,000 tokens?" is monotonic. If the top 40
fit, the top 39 do too: yes, yes, yes, no, no. So the agent halves the range 0
to 380 and finds the largest k that fits in nine builds instead of 380.

This is binary search on the answer: the budget is fixed, each check is
expensive, and the question is where the line falls. Any agent that fits as
much as it can into a fixed context window needs this loop.

## Your turn

Two challenges. The first searches a sorted list for a value that is usually
not in it, so the answer is the insertion point, and the work is getting the
off-by-one right. The second has no list. You decide what the candidate answers
are, write the yes-or-no question, and check which way the yeses run before
writing the loop.
