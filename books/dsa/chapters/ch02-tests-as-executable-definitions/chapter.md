---
id: ch02
part: I
title: Tests as executable definitions
edition: 0.1.0
---

# Chapter 2 — Tests as executable definitions

Chapter 1's challenge could not really go wrong. This one can — famously.
It is the canonical exercise from the classic algorithms course lineage:
**maximum pairwise product**, the problem that teaches stress testing,
because nearly everyone's first "obviously correct" fast solution has a bug
that no hand-written example catches.

## The story

The Meridian Times analytics desk ranks story pairs by combined engagement.
Given the engagement scores of `n` stories, they want the maximum product of
two *different* stories' scores. Scores can be negative (corrections and
retractions bleed engagement), which is exactly where naive intuition dies:
the answer might come from the two *largest* scores — or the two *most
negative* ones, whose product is positive.

## Two solutions, one lesson

Your starter file ships with `max_pairwise_product_naive`: a double loop
over all pairs. It is slow — about n²/2 products — but it is **obviously
correct**, and "slow but obviously correct" is one of the most valuable
artifacts in algorithm work. It becomes the referee.

Your job is `max_pairwise_product`: the fast version, one pass (or a sort),
handling negatives correctly.

The grader's stress tier plays them against each other on hundreds of
random inputs. If your fast version disagrees with the naive one even once,
you'll get the exact failing input back. This — a fast candidate checked
against a slow referee on random inputs — is *stress testing*, and it is the
single most transferable habit in this book.

## The challenge: `max_pairwise_product`

**Task.** Return the maximum value of `numbers[i] * numbers[j]` over all
pairs `i != j`.

**Input format.** A list of Python ints, `numbers`.

**Constraints.** `2 <= len(numbers) <= 3 * 10**5`;
`-2 * 10**5 <= numbers[k] <= 2 * 10**5`. Values may repeat.

**Output.** One int: the maximum pairwise product.

**Time limit (perf tier).** 5 seconds for `n = 300_000`. The naive double
loop would need roughly 4.5 × 10^10 multiplications — hours. Your fast
version should be O(n) or O(n log n).

**Hint discipline.** Try it before reading any further than this spec. If
stress fails, *shrink* the failing input by hand until the bug is obvious.

## Run it

```bash
python3 book/tools/runner.py start ch02
# edit book/workspace/ch02/pairwise.py  (implement max_pairwise_product)
python3 book/tools/runner.py run ch02
```

## Quiz

1. Why does "take the two largest numbers" fail on
   `[-9, -8, 1, 2]`? What is the correct answer there?
2. Why is the naive O(n²) solution worth writing at all if we then throw it
   away?
3. The stress test uses a fixed random seed. What do we gain, and what do we
   give up, by making randomness reproducible?
4. Your fast solution passes 500 random rounds. Is it proven correct?

**Expected ideas.** (1) `(-9) × (-8) = 72` beats `1 × 2 = 2`; two most
negative values can win. (2) It's the referee: a trusted oracle for stress
testing, and an executable statement of the spec. (3) Reproducible failures
you can paste into a debugger; the cost is less input diversity per run —
which the round count compensates for. (4) No — tests build confidence, not
proof; that's why the edge tier pins the boundary cases explicitly.

## Rucksack note

Still standalone, still on purpose. But name the pattern for later: when we
build retrieval in Part II, the "slow but obviously correct" referee will be
*reading every file*, and the "fast candidate" will be *the index*. Stress
testing retrieval against full scans is how we'll know the index tells the
truth.
