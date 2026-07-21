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

### Read and run in the browser

```bash
python3 book/tools/reader.py
```

That opens the standalone Rucksack publication at `http://127.0.0.1:8765`
(or the next available localhost port): book and chapter contents, chapter
pagination, EPUB download, the full chapter rail, an editor backed by
`book/workspace/`, tier-by-tier grader output, XP, badges, and streaks.

The Ernie.SG Study listing, inline web rendition, device-profile EPUB preview,
and link to this standalone reader are a separate publication-library surface
tracked in `erniesg/erniesg#70`; this localhost app does not pretend to be the
blog.

The reader binds to localhost only. Your Python still runs in the grader's
time-limited subprocesses; nothing is sent to a remote service.

Use `python3 book/tools/reader.py --no-open` when you do not want it to open a
browser automatically. Press Ctrl-C in the terminal to stop the reader.

### Export the EPUB

```bash
python3 book/tools/export.py
```

The standards-based EPUB 3 file is written to `book/dist/`. It contains the
Rucksack cover, title page, preface, table of contents, and every authored
chapter. The EPUB is reflowable for e-readers and tablets; executable Python
stays in the web edition, where the grader can isolate and time it safely.

### Terminal loop

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
