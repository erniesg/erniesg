+++
id = "front-matter"
kind = "concept"
title = "Before the first line of code"
+++

# Before the first line of code

## Why this matters

People care about outcomes, not computers.

A clinic clears a patient every four minutes. At 4pm thirty-eight people are
waiting when a man walks in with chest pain. Serve the queue in arrival order
and he is seen at 6:32pm. Serve it by urgency and he is seen in four minutes —
but someone has to re-scan the whole queue every time anyone new arrives.

Same list, same staff. That whole difference is what data structures and
algorithms are — ways of arranging what you have so the answer comes back in
time. DSA, if you meet the initials somewhere.

Code delivers outcomes like that at volumes people can't. Coding agents write
the code. Both are only as good as the methods inside them, so you build one
here, piece by piece, because that is how the intuition sticks.

## What you build

A coding agent: it indexes a repository, finds what a question needs, plans a
change, applies a patch, runs the tests, reports back.

Every structure in this book earns its place by making it better.

| Structure | What it buys the agent |
|---|---|
| Hash maps, tries | stop reading every file |
| LRU | keep what it will need again |
| Dynamic programming | diffs and patches |
| Topological order | what runs before what |
| Bounded concurrency | many tools at once, without melting the API |
| Greedy, binary search | stay inside a token budget |

## How it builds

- **0 · The loop** — read a statement, design, prove yourself wrong, fix.
- **I · Programming basics** — values, lists, loops, functions, dictionaries,
  reading an error, and counting the work before you run it.
- **II · Lookup** — hash maps, order, binary search.
- **III · Scanning** — prefix sums, two pointers, windows, stacks.
- **IV · Recursive structure** — recursion, trees, divide and conquer.
- **V · Graphs** — traversal, dependency order, connectivity, paths, spanning trees.
- **VI · Optimization** — dynamic programming, and when greedy is provably right.
- **VII · The agent's structures** — heaps, tries, LRU, bits.
- **VIII · Engineering** — tests that find real bugs, concurrency that holds up.
- **IX · At scale** — design cases where the answer is an architecture.
- **Capstone** — assemble the agent.

Each chapter: a situation where the outcome matters, the idea, the agent's
version of it, then challenges you write yourself.

## How to work through it

Every challenge is graded by four tiers that stop at the first failure; the
next chapter earns them on a problem that fails three of them.

Every chapter ends with a ladder. The first problem is worked through with you,
the next carry hints, and the last are yours alone: no hints, and a worked
solution meant for after you have written your own. The book ends the same way,
with a capstone that needs everything at once.

The first run is meant to be red. Hints are staged and free; read the solution
only once you have a failing test you understand — that order is the method, and
keeping to it is yours to do. Where the tiers can run, they will hold you to it:
`python3 books/tools/preview.py` serves this same book with the grader
behind it.
