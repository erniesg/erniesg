---
id: ch01
part: I
title: What an algorithm actually is
edition: 0.1.0
---

# Chapter 1 — What an algorithm actually is

An algorithm is a finite, unambiguous recipe: given an input that satisfies
stated constraints, it produces the required output in a bounded number of
steps. That's it. Everything else in this book — indexes, graphs, routing,
context packing — is this sentence with better data structures.

Two ideas matter from day one:

1. **The specification is the tests.** English is ambiguous; a test suite is
   not. In this book, a chapter's tests *are* its definition of done. When
   the grader is green, you're done; when it's red, you're not — no vibes.
2. **Correct is not the same as fast.** Even something as innocent as adding
   two numbers costs time proportional to how many digits they have. Python
   integers are arbitrary-precision: adding two million-digit numbers is
   real, measurable work. The perf tier of this chapter makes you feel that,
   gently, before Chapter 3 gives it a name (Big-O).

## How grading works

Every chapter is graded in four tiers, in order, stopping at the first
failure:

| Tier    | Question it answers                                        |
| ------- | ---------------------------------------------------------- |
| public  | Does it work on the visible examples?                      |
| edge    | Does it survive boundaries — zeros, negatives, huge values?|
| stress  | Does it agree with a brute-force reference on hundreds of randomized inputs? |
| perf    | Does it finish a huge input inside the time limit?         |

This mirrors how serious algorithms courses grade, and how you'll debug real
systems at the fictional Meridian Times newsroom later in this book: visible
repro first, boundaries second, randomized adversaries third, scale last.

## The challenge: `add`

Warm-up, deliberately tiny — the point is to run the full loop once:
start → red → edit → green.

**Task.** Implement `add(a, b)` returning the sum of two integers.

**Input format.** Two Python ints `a`, `b`.

**Constraints.** `-10**1_000_000 <= a, b <= 10**1_000_000` (yes, up to a
million digits — Python handles it; your job is just not to break it).

**Output.** The integer `a + b`.

**Time limit (perf tier).** 10 seconds for a handful of additions of
million-digit numbers.

Do it honestly: no `eval`, no shelling out. One line is a perfectly good
solution — this chapter is about the workflow, not cleverness.

## Run it

```bash
python3 book/tools/runner.py start ch01
# edit book/workspace/ch01/warmup.py
python3 book/tools/runner.py run ch01
```

## Quiz (answer before peeking at the solution)

1. Why do we say the tests are the specification, not the prose?
2. `add` is "O(1)" in the everyday sense — why is that claim actually false
   for Python integers? What does the cost grow with?
3. The starter returns `0` — the grader's public tier fails. Why is starting
   red a *feature* of this workflow rather than an annoyance?

**Expected ideas.** (1) Prose is ambiguous and ungradable; tests execute.
(2) Arbitrary-precision addition is linear in the number of digits.
(3) A red start proves the tests can fail, so a later green actually means
something — a test that can't fail verifies nothing.

## Rucksack note

Nothing to port yet — this is a standalone file, on purpose. Interlude A
(end of Part I) is where scripts grow into a package; Rucksack itself enters
at Interlude B. Resist wiring things in early.
