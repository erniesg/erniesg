# Preserve code, pseudocode, and algorithm listings as preformatted structure

depends-on: 012,024,035

## Provider

vm-codex

## Goal

Keep a listing a listing. Source code, pseudocode, algorithm environments, shell transcripts, and configuration blocks carry meaning in their line breaks and indentation. The pipeline currently reflows them into running prose, so every character survives and all of the structure is lost.

## Observed failure

On a one-column paper a pseudocode block rendered into the EPUB as a single paragraph:

```
contract ArbitrageA I { DataAnalyzer dataAnalyzer ; // AI module for data analysis PriceFeed priceFeed ; //Interface for real time price data function Arbitrage public(){ // Analyze Market Conditions Using AI MarketTrends trends = dat…
```

The generated XHTML contains zero `<pre>` and zero `<code>` elements. Braces, comments, and statements run together on one line, nesting is gone, and the block is unreadable as code. `textCoverage` for that document is 0.99936, so no completeness metric registers a problem.

## Acceptance tests

- A listing is detected from source evidence, not from a language word list: a run of lines sharing a monospaced font family, or exhibiting preserved leading indentation and short ragged line lengths that do not justify to the body measure, within one region lane.
- An accepted listing is emitted as preformatted structure with its source line breaks and leading indentation preserved exactly, and marked so the reading system does not re-wrap it destructively. Trailing whitespace is normalized; leading whitespace is not.
- Line-join rules do not apply inside a listing. A line ending in a hyphen, an operator, or an open bracket is never joined to the next line, and no discretionary-hyphen decision is recorded for a boundary inside a listing.
- A listing carries source provenance per line and appears exactly once in canonical order, in the position its source geometry gives it.
- A listing that exceeds the profile measure scrolls within its own bounded container. It never forces horizontal overflow on the page body, at any supported profile width.
- A caption or label attached to a listing (`Algorithm 1`, `Listing 2`) stays anchored to it and is not absorbed into it or into neighbouring prose.
- Ordinary prose is never promoted to a listing. A justified body paragraph, a bibliography entry, and a table row each remain what they are, and a document with no listing gains no `<pre>`.
- Detection that cannot be proved leaves the text as prose and records a named diagnostic rather than guessing structure.
- Fixtures cover: an indented brace-language listing, an algorithm environment with numbered lines, a shell transcript, a listing spanning a page break, a listing spanning a column break in a two-column layout, and a document containing none.

## TDD sequence

1. **Red:** add the fixtures above and preserve failures showing flattened output and absent preformatted structure.
2. **Green:** implement monospace and indentation detection over source runs, then emit preformatted nodes carrying per-line provenance.
3. **Red then green:** suppress line-join and dehyphenation rules inside accepted listings, and add the bounded-scroll profile assertions.
4. **Refactor:** share the preformatted materializer between preview and export once byte-stability holds.

## Exact-head definition of done

- The observed pseudocode block renders with its original line breaks and indentation, inside preformatted structure, with per-line provenance.
- No document without a listing gains preformatted structure.
- No profile shows horizontal overflow on the page body because of a listing.
- From a clean checkout of the immutable PR head, `scripts/agent-evidence --all` records `commit` equal to that head, `dirty: false`, and `result: passed`.

## Validation command

```bash
npx vitest run src/research/pdf-layout.test.ts src/research/pdf-lines.test.ts src/research/epub.test.ts
npm test
npm run build
npm run test:e2e -- tests/e2e/srt-visual.spec.ts
```

## Allowed secrets

None.
