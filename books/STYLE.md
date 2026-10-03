# How the books are written

Rules for every chapter and challenge in `books/`. They come from the owner's
margin notes on ch05 (2026-10-03). A note on one passage applies wherever the
same thing happens. The owner found the book naggy, wordy and confusing in
several places.

## Plain

- One idea per sentence. Two rules in one sentence get split.
- Say what a thing does before saying why it matters.
- No compressed, epigram-style phrasing. If a sentence needs rereading to see
  what it claims, rewrite it in the words you would use out loud.
- Name the thing. "The second call used the default list" is better than "it
  has been collecting since the program started".

Before: "Not every tray holds 12. Give the size a default and callers may stay
quiet when 12 is right."

After: "So far every tray holds 12. Some hold 20 or 50, so the size should be
something the caller can pass in. But most trays do hold 12, and making every
caller type 12 is noise. A default does both: `per_tray=12` in the `def` line
means "use 12 unless the caller hands over a different number"."

## Not naggy

- No verdicts on the reader or on beginners: not "this is the confusion that
  costs beginners the most hours", "nearly every time you see it", or "the
  rule is flat".
- Don't call something a trap, a curiosity or the hardest kind of bug. Show
  what goes wrong and let the output make the point.
- Give a rule once, where it is shown. Don't repeat it as a warning later.

## Short

- Cut filler sentences ("Three parts worth naming.", "Now the trap.") and any
  sentence that repeats the code's output in words.
- Prefer the shorter word: "returned nothing" over "handed back nothing".
- Keep the examples and their numbers. Most cuts come from the sentences
  around the code, not from the code.

Before (two rules in one sentence): "Arguments with defaults come after the
ones without. Naming the argument at the call — `per_tray=50` — is worth doing
as soon as a call carries more than one number; `trays_for(310, 50)` is two
mystery numbers when you meet it again in a month."

After: two short paragraphs, one per rule, each with its example. See
`chapters/ch05-functions.md`, "Default arguments".

## Exercises check the work

An exercise's check line must fail for the likely wrong answers, not only pass
the right one. A reader wrote `capacity % booked` in place of
`capacity - booked`, and it printed the expected 9 (40 % 31 + 12 % 12 is
9 + 0). `books/tools/validate.py` now swaps each arithmetic operator in the
lines the reader writes and fails the book when a swapped version still prints
the expected output. Pick check values that separate the operators: an exact
fit, a near miss and an ordinary case.

## Facts stay true

Every number or output quoted in prose must match what the code on the page
prints. Rerun it after an edit.
