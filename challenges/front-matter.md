+++
id = "front-matter"
kind = "concept"
title = "Before the first line of code"
figure = "three-prices"
+++

# Before the first line of code

:::figure{id="three-prices"}
The same 200 bikes, three methods, counted.
:::

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
- **I · Python and cost** — counting the work before running it.
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

Four tiers grade every challenge, stopping at the first failure.

- **Public** — the statement's own examples.
- **Edge** — empty, single, all-identical, the largest legal value.
- **Stress** — your code against an obviously-correct slow one on random
  inputs. This is the tier that finds what you didn't imagine.
- **Perf** — an input big enough that a correct-but-slow answer fails.

The first run is meant to be red. Hints are staged and free; read the solution
only once you have a failing test you understand. Everything runs in the
browser, or from a terminal if you prefer.
