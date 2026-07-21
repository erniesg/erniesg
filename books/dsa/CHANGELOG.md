# Changelog

## Unreleased

- Added complete book and chapter contents to the standalone executable reader.
- Added a standards-based EPUB 3 export with Rucksack cover, front matter,
  navigation, and all authored chapters.
- Defined canonical book metadata for later Ernie.SG Study integration.

## 0.1.0 — 2026-07-21

- Initial edition: plan (`PLAN.md`), four-tier grader (`tools/runner.py`)
  with its own unit tests, and three runnable chapters:
  - ch01 — What an algorithm actually is (`add`, million-digit perf tier)
  - ch02 — Tests as executable definitions (`max_pairwise_product`,
    stress-tested against a brute-force referee, negatives included)
  - ch03 — Counting work: Big-O without the maths fog (`first_duplicate`,
    O(n²) fails the 500k perf tier by design)
- Naming policy: all scenarios use the fictional Meridian Times newsroom.
