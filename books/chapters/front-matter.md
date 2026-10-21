+++
id = "front-matter"
kind = "concept"
title = "Before the first line of code"
+++

# Before the first line of code

## Why this matters

A clinic sees one patient every four minutes. At 4pm thirty-eight people are
waiting when a man walks in with chest pain. If the queue is served in arrival
order, he is seen at 6:32pm. If it is served by urgency, he is seen in four
minutes. The cost is that someone has to re-scan the whole queue each time a
new patient arrives.

The list and the staff are the same in both cases. Only the method changed.
Data structures and algorithms (DSA) are methods like this: ways of arranging
what you have so the answer comes back in time.

Code applies methods like these at volumes people can't. Coding agents write
code, and they are only as good as the methods inside them. In this book you
build one, piece by piece.

## What you build

A coding agent. It indexes a repository, finds what a question needs, plans a
change, applies a patch, runs the tests and reports back.

Each structure in this book makes the agent better.

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

Each chapter has four parts: a situation where the outcome matters, the idea,
the agent's version of it, and challenges you write yourself.

## How to work through it

Each challenge is graded in four tiers of tests. Grading stops at the first
tier that fails. The next chapter explains the tiers using a problem that fails
three of them.

Each chapter ends with a ladder of challenges. The first is worked through with
you. The next ones have hints. The last ones have no hints, and their worked
solution is for reading after you have written your own. The book ends the same
way, with a capstone that uses everything.

Your first run will usually fail some tests. Hints are revealed one at a time
and cost nothing. Read the solution only once you have a failing test you
understand. Where the tiers can run, they hold you to that order:
`python3 books/tools/preview.py` serves this book with the grader running
behind it.
