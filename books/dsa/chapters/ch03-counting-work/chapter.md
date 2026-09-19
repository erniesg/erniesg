---
id: ch03
part: I
title: "Counting work: Big-O without the maths fog"
edition: 0.1.0
---

# Chapter 3 — Counting work: Big-O without the maths fog

Big-O is not maths hazing. It answers one practical question: **when the
input gets k times bigger, how much more work do I do?**

- O(1): the same amount. Looking up a key in a dict.
- O(n): k times more. Reading every line of a file once.
- O(n²): k² times more. Comparing every item against every other item.

That last one is the silent killer. On 1,000 items, n² is a million steps —
instant. On 500,000 items it is 2.5 × 10^11 steps — your laptop fan's
villain origin story. Nothing "crashed"; you just wrote code whose cost
grows with the *square* of the input, and the input grew.

## The story

The Meridian Times publishing pipeline collects every asset path a Compass
article references — images, embeds, Sideboard cards. A path appearing twice
means a duplicate embed, and the *first* duplicated path is what the editor
wants flagged. The pipeline handles half a million paths on a big interactive
feature. The intern's version compared each path against every earlier path
— a list membership check inside a loop — and the nightly job went from
seconds to forty minutes. Same answer, wrong shape of cost.

## The idea: pay memory to stop re-scanning

A Python `set` (like a dict) is a hash table: membership checks cost O(1)
*expected*, not O(n). Keep a set of everything seen so far; for each new
item, one membership check, one insert. Total: O(n) expected. The list
version does the same membership check in O(n) each time — O(n²) total.

Same loop. One data structure swap. That's most of what "knowing DSA" is.

## The challenge: `first_duplicate`

**Task.** Return the first value whose **second** occurrence appears
earliest in the list, or `None` if all values are unique.

**Input format.** A list of strings `paths` (may contain any Unicode).

**Constraints.** `0 <= len(paths) <= 5 * 10**5`; each string ≤ 200 chars.

**Output.** The duplicated string, or `None`.

**Examples.**
- `["a.jpg", "b.png", "a.jpg"]` → `"a.jpg"`
- `["a", "b", "b", "a"]` → `"b"` (b's second occurrence comes first)
- `["a", "b"]` → `None`

**Time limit (perf tier).** 5 seconds for 500,000 paths with the duplicate
placed at the very end — the adversarial layout that makes O(n²) pay full
price.

## Run it

```bash
python3 books/dsa/tools/runner.py start ch03
# edit books/dsa/workspace/ch03/dedup.py
python3 books/dsa/tools/runner.py run ch03
```

## Quiz

1. `value in some_list` and `value in some_set` are the same syntax. Why is
   one O(n) and the other O(1) expected?
2. Why does the perf test put the duplicate at the *end* of the list?
3. The set solution uses O(n) extra memory; the list-scan uses O(1) extra
   (it can scan in place). When would that trade go the other way?
4. Why "expected" O(1) and not guaranteed?

**Expected ideas.** (1) A list must be scanned; a set hashes to a bucket.
(2) An early duplicate lets even O(n²) exit fast — adversarial placement
forces the worst case. (3) When memory is the scarce resource — a theme
Part III (memory limits, LRU) takes seriously. (4) Hash collisions: rare
degenerate inputs can degrade buckets; "expected" is a probabilistic claim.

## Rucksack note

This chapter is the seed of the Part I milestone: an **exact identifier
index** is "the set of everything seen, remembered with positions" — pay
memory once at index time so lookups stop re-scanning the repository. When
Part II builds the inverted index, the referee (read every file) vs
candidate (consult the index) pattern from Chapter 2 combines with this
chapter's structure. Still no Rucksack wiring — that discipline holds until
Interlude A.
