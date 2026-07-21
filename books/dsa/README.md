# The Rucksack Book of Data Structures & Algorithms

Learn DSA from zero by building, chapter by chapter, the ideas behind a
Rucksack-native context engine. Every chapter is a test-driven coding
challenge, automatically graded in four tiers: **public → edge → stress →
perf** (huge inputs under a time limit, in the tradition of the classic
algorithms-course graders).

See [PLAN.md](PLAN.md) for the full outline, testing doctrine, naming
policy, publishing pipeline (EPUB / web / blog), gamification, and the
definition of done.

## Quickstart

Requires Python 3.11+. No dependencies.

```bash
python3 book/tools/runner.py list          # what's available, what's green
python3 book/tools/runner.py start ch01    # copy starter into your workspace
# read book/chapters/ch01-*/chapter.md, then edit book/workspace/ch01/*.py
python3 book/tools/runner.py run ch01      # grade tier by tier
python3 book/tools/runner.py status        # XP, badges, streak
```

Your code lives in `book/workspace/` (gitignored). The grader never edits
your code; you never edit the tests. Reference solutions are in each
chapter's `solution/` directory — earn the green before you peek.

## For authors / CI

```bash
python3 book/tools/test_runner.py          # the grader's own unit tests
python3 book/tools/runner.py verify ch01   # reference solution passes all tiers
```
