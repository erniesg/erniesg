+++
id = "ch12-hash-maps"
kind = "concept"
title = "Hash maps and sets"
figure = "key-to-slot"

teaches = ["hash-maps"]
requires = ["ch11-counting-work"]
assessed-by = ["most-common-basket", "two-lines-that-balance"]
powers = ["agent-symbol-lookup"]
+++

A polling station opens at seven. Four thousand two hundred people are on its
register, printed as one alphabetical list in a ring binder, and nobody gets a
ballot paper until a clerk has found their name and crossed it off.

One binder, one clerk. Finding a name takes about twenty seconds. At the
half-eight rush, ninety people arrive inside ten minutes, and the queue is out
of the door and along the pavement.

So the station splits the binder. Twenty-six tables, one per first letter of
the surname, each holding the names that start with it. A voter reads the
letters above the tables and walks to theirs. The clerk there is holding around
160 names, not 4,200.

Nobody read faster. The name decided the table.

That is the whole idea behind a dictionary, and Chapter 6 asked you to take it
on trust. This chapter shows you the trick, because the trick has three
consequences you will meet in real code: what happens when two names want the
same table, why you cannot use a list as a key, and when the whole arrangement
is the wrong one.

## Turn the key into a number

A computer has no letters above its tables, only numbered slots. So the first
job is to turn a key into a number. Any rule will do as long as it is quick and
always gives the same answer for the same key. Here is about the simplest one
that works: add up the character codes.

```python run
SLOTS = 8


def slot_for(key):
    return sum(ord(letter) for letter in key) % SLOTS


for name in ("ada", "sam", "mia", "amy", "hal"):
    print(name, "→ slot", slot_for(name))
```

`ord("a")` is 97, `ord("d")` is 100, so `"ada"` adds up to 294. The `% SLOTS`
folds that down into the range the table actually has: 294 divided by 8 leaves
6, so `"ada"` belongs in slot 6.

That number is called a **hash**, and the rule that produces it is a **hash
function**. Nothing mystical is happening. A hash is a fingerprint: short,
cheap to take, and the same every time you take it from the same thing.

:::figure{id="key-to-slot"}
:::

Now the table. Eight slots, each holding a small list of what has been filed
there:

```python run
table = [[] for _ in range(SLOTS)]

for name, shelf in (("ada", 12), ("sam", 9), ("mia", 7), ("amy", 3), ("hal", 15)):
    table[slot_for(name)].append((name, shelf))

for number, bucket in enumerate(table):
    print(number, bucket)
```

And the lookup, which is the point of all of it:

```python run
def look_up(key):
    compared = 0
    for stored_key, value in table[slot_for(key)]:
        compared += 1
        if stored_key == key:
            return value, compared
    return None, compared


print("mia:", look_up("mia"))
print("amy:", look_up("amy"))
print("ivy:", look_up("ivy"))
```

Read the second number in each line. Finding `mia` took one comparison.
Finding `amy` took two. Asking for `ivy`, who was never filed, took none at
all — the slot her name points at is empty, so there was nothing to read.

Not one of those numbers is five, and five names are in the table. That is the
flat line from Chapter 6, and now you can see what is holding it up.

## Two keys, one slot, no problem

`mia` and `amy` both landed in slot 7. That is a **collision**, and it is not a
bug or an edge case — it is guaranteed. Eight slots cannot hold a separate
place for every possible name, so some names must share.

A collision costs you one extra comparison. That is all. The slot holds a short
list and the lookup reads it, exactly like the clerk reading down a table of
160 names instead of a binder of 4,200.

The question worth asking is not *do collisions happen* but *how crowded does
the worst slot get*. Measure it at a size that matters:

```python run
symbols = [f"load_solution_{n}" for n in range(100_000)]
counts = [0] * 131_072
for symbol in symbols:
    counts[hash(symbol) % 131_072] += 1

print("100,000 keys spread over 131,072 slots")
print("  fullest slot holds:", max(counts))
print("  slots left empty:  ", counts.count(0))
```

A hundred thousand keys, and the busiest slot holds seven or eight of them.
Nearly half the slots hold nothing at all, which is the price: a hash table keeps
spare room on purpose, because a table that is nearly full collides constantly.
Python grows its dicts when they pass about two thirds full, re-filing every
key into the bigger table as it goes. You never see it happen, and it is why
`d[key] = value` is occasionally much slower than the line before it.

Run that cell twice and the two numbers move slightly. Python picks a random
seed for hashing text each time it starts, so the same word lands in a
different slot in a different program. That is deliberate: it stops someone
sending you a few thousand keys chosen to land in one slot and quietly turning
your dictionary back into a list.

## The rule has to spread, or none of this works

Everything above rests on the hash scattering keys evenly. Here is what happens
when it does not. These keys are realistic — the sort of thing a register or a
symbol table is full of — and they all look alike:

```python run
def added_up(key, slots):
    return sum(ord(letter) for letter in key) % slots


def shifted_along(key, slots):
    number = 0
    for letter in key:
        number = number * 31 + ord(letter)
    return number % slots


def fullest_slot(rule, keys, slots):
    counts = [0] * slots
    for key in keys:
        counts[rule(key, slots)] += 1
    return max(counts)


voters = [f"voter{n:05d}" for n in range(4_200)]
print("4,200 keys into 4,096 slots — worst slot:")
print("  character codes added up:", fullest_slot(added_up, voters, 4096))
print("  each letter shifted first:", fullest_slot(shifted_along, voters, 4096))
print("  Python's own hash:        ", fullest_slot(lambda k, s: hash(k) % s, voters, 4096))
```

Adding up character codes collapses here, by a factor of fifty. `voter00012`
and `voter00021` are made of the same characters in a different order, so they
add to the same number and land in the same slot. Multiplying by 31 as you go
makes position count, and the keys scatter.

Push it further and the failure becomes total:

```python run
def just_the_length(key, slots):
    return len(key) % slots


print("filed by length alone, worst slot:", fullest_slot(just_the_length, voters, 4096))
```

Every key is the same length, so every key is in slot 10 and the other 4,095
are empty. Look up a name and you read all 4,200. A hash table with a bad rule
is not slightly worse than a good one. It is a list.

That is the honest way to picture the whole structure, in fact:

```python run
for slots in (1, 64, 4096):
    worst = fullest_slot(shifted_along, voters, slots)
    print(f"{slots:>5} slot(s) → worst lookup reads {worst:>5} of the 4,200 names")
```

One slot is a list. Sixty-four slots read about 150 names at worst. Four
thousand slots read six. Choosing a dict over a list is choosing the bottom row
over the top one, and Chapter 11's arithmetic says what that choice is worth:
looking up all 4,200 names is up to 17 million comparisons on the top row and
about 25,000 on the bottom.

## A key has to be a thing that cannot change

Here is the consequence people trip over. A record is filed under the number
its key produced **at the moment it was filed**. If the key changes afterwards,
the number changes, and the record does not move.

```python run
def slot_for_crew(crew):
    return sum(ord(letter) for name in crew for letter in name) % SLOTS


cupboard = [[] for _ in range(SLOTS)]
crew = ["ada", "sam"]
cupboard[slot_for_crew(crew)].append((crew, "front desk"))
print("filed in slot", slot_for_crew(crew))

crew.append("mia")                       # a third person joins the shift
print("now looked for in slot", slot_for_crew(crew))
print("and that slot holds:", cupboard[slot_for_crew(crew)])
```

Nothing was deleted. The record is still sitting in slot 7, and every future
lookup goes to slot 6 and finds an empty shelf. This is the polling station's
version of a voter who married and changed their surname after the register was
printed: the card is under the old letter and the clerk is at the new table.

Python refuses to let you get into that state. You met the refusal in Chapter
6 — `TypeError: unhashable type: 'list'` — and this is the reason behind it. A
list can be changed after you make it, so it cannot be trusted to produce the
same number twice, so it cannot be a key. Text, numbers, `True`, `None` and
tuples all qualify, because none of them can be edited in place.

Which makes the fix one word:

```python run
seats = {}
crew = ["ada", "sam"]
seats[tuple(crew)] = "front desk"        # a snapshot, frozen at this moment
crew.append("mia")                       # the list moves on; the key does not
print(seats)
print(seats[("ada", "sam")])
```

`tuple(crew)` takes a copy that can never change. Editing `crew` afterwards
leaves the key alone, which is exactly what you want — and it is worth
understanding that a tuple of lists is still unhashable, because the lists
inside it can still move.

## Where a hash map is the wrong answer

Three places, and you will meet all three.

**It has no order.** A dict remembers the order you inserted things, and that
is all. There is no cheap way to ask for the smallest key, the next key after
this one, or every key between two dates. Those questions all cost a full pass:

```python run
readings = {"14:00": 21, "13:00": 19, "15:00": 24}
print(min(readings), "— found by reading every key")
print(sorted(readings), "— and this puts them all in order from scratch")
```

Three keys, so it does not matter. Three hundred thousand, asked a thousand
times, and it is the only thing that matters. Ordered questions want an ordered
structure, which is the next two chapters.

**It costs memory.** The empty slots are not free:

```python run
import sys

numbers = list(range(100_000))
print("list:", sys.getsizeof(numbers), "bytes")
print("set: ", sys.getsizeof(set(numbers)), "bytes")
print("dict:", sys.getsizeof({n: n for n in numbers}), "bytes")
```

Five to six times the space, for the same hundred thousand numbers. Usually a
fine trade. On a machine with a gigabyte and a repository with ten million
symbols, it is a decision rather than a reflex.

**Some keys cannot be hashed at all.** Lists, dicts and sets are out, and so is
anything of your own that you intend to keep editing. When the natural key is
mutable, freeze it — `tuple(...)` for a list, `frozenset(...)` for a set — and
accept that you are keying on a snapshot.

One more, quieter than the others: a hash table's good behaviour is an average,
not a promise. Feed it keys that all collide and every lookup reads the whole
slot. Randomised hashing makes that hard to arrange on purpose in Python, but
the shape is still there underneath, and it is why "constant time" gets the
word *expected* in front of it in careful writing.

## What this buys the agent

The agent calls tools, and the same tool gets called with the same arguments
over and over — read this file, list this directory, find this symbol. Caching
the answers is the difference between a session that feels alive and one that
does not.

A cache is a dict, and the key has to describe the call: the tool's name and
the arguments it was given. Those arguments arrive as a list, which cannot be a
key, so the agent freezes them first:

```python run
cache = {}


def call(tool, paths):
    key = (tool, tuple(paths))          # frozen, so it hashes the same twice
    if key in cache:
        return "cached:", cache[key]
    cache[key] = f"{tool} over {len(paths)} file(s)"
    return "computed:", cache[key]


print(*call("read", ["a.py", "b.py"]))
print(*call("read", ["a.py", "b.py"]))
print(*call("read", ["a.py"]))
```

Drop the `tuple` and the agent crashes on its first cached call. Keep the list
and mutate it later — append one more path to the batch — and you get the
worse version of the same bug: no crash, wrong answers, filed under a number
nobody will ever compute again.

## Your turn

Two challenges. The first is talked through, and it will refuse to run until
you have dealt with a key that cannot be hashed. The second gives you a
question that looks like it needs every pair, and a perf tier sized so that
every pair is not an option.
