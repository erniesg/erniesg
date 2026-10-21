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

One binder, one clerk. Finding a name takes about twenty seconds. At half
past eight, ninety people arrive inside ten minutes, and the queue runs out of
the door.

So the station splits the binder into twenty-six tables, one per first letter
of the surname. A voter reads the letters above the tables and walks to theirs.
The clerk there holds around 160 names, not 4,200. Nobody reads faster; the
voter's own name tells them which table to go to.

That is how a dictionary works. Chapter 6 asked you to take it on trust. This
chapter shows how it is done, and three things that follow from it: what
happens when two names want the same table, why a list cannot be a key, and
when a dictionary is the wrong choice.

## Turn the key into a number

A computer has numbered slots, not letters above tables. So the first job is
to turn a key into a number. Any rule will do if it is quick and always gives
the same number for the same key. One of the simplest is to add up the
character codes:

```python run
SLOTS = 8


def slot_for(key):
    return sum(ord(letter) for letter in key) % SLOTS


for name in ("ada", "sam", "mia", "amy", "hal"):
    print(name, "→ slot", slot_for(name))
```

`ord("a")` is 97 and `ord("d")` is 100, so `"ada"` adds up to 294. `% SLOTS`
brings that into the range of the table: 294 divided by 8 leaves 6, so `"ada"`
goes in slot 6.

That number is a **hash**, and the rule that produces it is a **hash
function**. A hash is like a fingerprint: short, cheap to take, and the same
every time you take it from the same thing.

:::figure{id="key-to-slot"}
:::

Now the table: eight slots, each holding a small list of what was filed
there.

```python run
table = [[] for _ in range(SLOTS)]

for name, shelf in (("ada", 12), ("sam", 9), ("mia", 7), ("amy", 3), ("hal", 15)):
    table[slot_for(name)].append((name, shelf))

for number, bucket in enumerate(table):
    print(number, bucket)
```

And the lookup:

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

The second number in each line is the count of comparisons. `ivy` was never
filed, and took none, because the slot her name points at is empty. Five names
are in the table, but no lookup read all five. That is the flat line from
Chapter 6, and this is what keeps it flat.

:::exercise{id="ch12-slot-by-hand"}
Write the adding-up rule yourself, for 8 slots, and print where `ivy` and
`zoe` would be filed.

```python
def slot_for(key):
    # your code here
    ...


print(slot_for("ivy"))
print(slot_for("zoe"))
```

```output
0
6
```

```answer
def slot_for(key):
    return sum(ord(letter) for letter in key) % 8


print(slot_for("ivy"))
print(slot_for("zoe"))
```
:::

## Two keys, one slot, no problem

`mia` and `amy` both landed in slot 7. That is a **collision**. Collisions
are normal: eight slots cannot give every possible name its own place, so some
names share.

A collision costs one extra comparison. The slot holds a short list and the
lookup reads it, like the clerk reading down 160 names instead of 4,200.

So the useful question is how crowded the worst slot gets. Here it is measured
with many more keys:

```python run
symbols = [f"load_solution_{n}" for n in range(100_000)]
counts = [0] * 131_072
for symbol in symbols:
    counts[hash(symbol) % 131_072] += 1

print("100,000 keys spread over 131,072 slots")
print("  fullest slot holds:", max(counts))
print("  slots left empty:  ", counts.count(0))
```

The busiest slot holds seven or eight keys. Nearly half the slots are empty.
That spare room is deliberate, because a nearly full table collides all the
time. Python grows a dict when it passes about two thirds full and re-files
every key into the bigger table. This happens out of sight, and it is why
`d[key] = value` is occasionally much slower than the line before it.

Run the cell twice and the numbers change slightly. Python picks a random seed
for hashing text each time it starts, so the same word can land in a different
slot in another run. This stops someone from sending a few thousand keys chosen
to land in one slot, which would turn the dictionary back into a list.

## The rule has to spread, or none of this works

All of this depends on the hash spreading keys evenly. These keys are the
kind a register or a symbol table is full of, and they all look alike:

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

Adding up character codes puts about fifty times as many keys in the worst
slot. `voter00012` and `voter00021` have the same characters in a different
order, so they add up to the same number and share a slot. Multiplying by 31 at
each step makes position count, and the keys spread out.

A worse rule files every key by its length:

```python run
def just_the_length(key, slots):
    return len(key) % slots


print("filed by length alone, worst slot:", fullest_slot(just_the_length, voters, 4096))
```

Every key is the same length, so every key is in slot 10 and the other 4,095
are empty. Looking up a name reads all 4,200. With this rule the hash table is
just a list.

The number of slots moves a table between those two extremes:

```python run
for slots in (1, 64, 4096):
    worst = fullest_slot(shifted_along, voters, slots)
    print(f"{slots:>5} slot(s) → worst lookup reads {worst:>5} of the 4,200 names")
```

One slot is a list. A dict with a good hash is the bottom row. Using Chapter
11's arithmetic, looking up all 4,200 names costs up to 17 million comparisons
on the top row and about 25,000 on the bottom.

## A key has to be a thing that cannot change

A record is filed under the number its key produced **when it was filed**. If
the key changes afterwards, the number changes, but the record does not
move.

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

The record is still in slot 7, and every later lookup goes to slot 6, which
is empty. At the polling station, this is a voter who changed their surname
after the register was printed: the card is under the old letter, and the
clerk is at the new table.

Python stops this from happening. Chapter 6 showed the error, `TypeError:
unhashable type: 'list'`, and this is the reason for it. A list can change
after it is made, so it may not give the same number twice, so it cannot be a
key. Text, numbers, `True`, `None` and tuples can be keys, because none of them
can be edited in place.

The fix is to key on a tuple:

```python run
seats = {}
crew = ["ada", "sam"]
seats[tuple(crew)] = "front desk"        # a snapshot, frozen at this moment
crew.append("mia")                       # the list moves on; the key does not
print(seats)
print(seats[("ada", "sam")])
```

`tuple(crew)` makes a copy that cannot change, so editing `crew` afterwards
leaves the key alone. A tuple that contains lists is still unhashable, because
the lists inside it can change.

:::exercise{id="ch12-count-routes"}
Each trip arrives as a list of stops. Count how many times each route was
taken. A list cannot be a key.

```python
trips = [["depot", "school"], ["school", "market"], ["depot", "school"]]
counts = {}
for trip in trips:
    # your code here
    ...
print(counts)
```

```output
{('depot', 'school'): 2, ('school', 'market'): 1}
```

```answer
trips = [["depot", "school"], ["school", "market"], ["depot", "school"]]
counts = {}
for trip in trips:
    key = tuple(trip)
    counts[key] = counts.get(key, 0) + 1
print(counts)
```
:::

## Where a hash map is the wrong answer

**It has no order.** A dict remembers the order things were inserted, and
nothing more. There is no cheap way to ask for the smallest key, the next key
after this one, or every key between two dates. Each of those costs a full
pass:

```python run
readings = {"14:00": 21, "13:00": 19, "15:00": 24}
print(min(readings), "— found by reading every key")
print(sorted(readings), "— and this puts them all in order from scratch")
```

With three keys this costs nothing. With three hundred thousand keys, asked a
thousand times, it is most of the work. Ordered questions need an ordered
structure, which is what the next two chapters cover.

**It costs memory.** The empty slots take space:

```python run
import sys

numbers = list(range(100_000))
print("list:", sys.getsizeof(numbers), "bytes")
print("set: ", sys.getsizeof(set(numbers)), "bytes")
print("dict:", sys.getsizeof({n: n for n in numbers}), "bytes")
```

The set takes about five times the space of the list, and the dict about six
and a half, for the same hundred thousand numbers. Usually that is fine. On a
machine with a gigabyte of memory and a repository with ten million symbols, it
is worth weighing.

**Some keys cannot be hashed.** Lists, dicts and sets cannot be keys, and
neither can anything of your own that you plan to keep editing. When the
natural key can change, freeze it with `tuple(...)` for a list or
`frozenset(...)` for a set. The key is then a snapshot.

**Speed is not guaranteed.** If all the keys collide, every lookup
reads the whole slot. Python's random seed makes that hard to arrange on
purpose, but it does not rule it out. That is why careful writing calls a hash
table lookup *expected* constant time.

:::exercise{id="ch12-same-letters"}
`listen` and `silent` are the same letters in a different order, which is
what broke the adding-up hash. Group the words by their sorted letters and
print how many groups there are.

```python
words = ["listen", "silent", "enlist", "google", "gogole", "cat"]
groups = {}
for word in words:
    # your code here
    ...
print(len(groups))
```

```output
3
```

```answer
words = ["listen", "silent", "enlist", "google", "gogole", "cat"]
groups = {}
for word in words:
    key = "".join(sorted(word))
    if key not in groups:
        groups[key] = []
    groups[key].append(word)
print(len(groups))
```
:::

## What this buys the agent

The agent calls the same tool with the same arguments again and again: read
this file, list this directory, find this symbol. Caching the answers makes
those repeat calls instant.

A cache is a dict whose key describes the call: the tool's name and its
arguments. The arguments arrive as a list, which cannot be a key, so the agent
turns them into a tuple first:

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

Without the `tuple`, the first call raises `TypeError`. If the list could be
a key and were changed later, say by appending one more path, the entry would
sit under a number no later lookup computes, and the cache would give wrong
answers without crashing.

## Your turn

Two challenges. The first walks you through it, and it will not run until
you deal with a key that cannot be hashed. The second looks like it needs every
pair, and its perf tier is too large for that.
