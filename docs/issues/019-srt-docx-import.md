# Import born-structured DOCX manuscripts into the SRT pipeline

depends-on: 013

## Provider

vm-codex

## Goal

Add a local DOCX import path that maps the explicit structure of an OOXML manuscript — heading hierarchy, paragraphs with inline formatting, footnotes and endnotes with explicit references, embedded images with captions, and tables — into the same canonical research-paper graph and completeness gate the PDF importer feeds, so born-structured manuscripts export EPUBs deterministically without any of the PDF reconstruction ambiguity.

## Acceptance tests

- A `.docx` file parses fully locally (the OOXML zip container read with the `fflate` dependency already in the tree; no new network or native dependencies) into the same reconstruction and paper types defined in `src/research/import-types.ts` and `src/research/schema.ts`.
- Heading levels map to the section hierarchy; paragraphs preserve bold, italic, and hyperlink runs; footnotes and endnotes map to note nodes with their references resolved deterministically from the explicit OOXML relationship ids — never through the geometric note matcher — and report relationship coverage of 1.0.
- Embedded images are extracted with their captions associated from adjacent caption paragraphs, and tables map to structured table nodes, reusing the asset node shapes the issue-013 work established.
- A well-formed synthetic fixture manuscript passes the completeness gate with full text, asset, and relationship coverage and exports a valid EPUB verified by `inspectEpub` plus the structural invariants; a deliberately malformed fixture (a missing image part, a dangling note reference) fails closed with named diagnostics.
- The publication importer at `src/components/research/PublicationImporter.tsx` accepts `.docx` alongside `.pdf`, and the e2e flow imports the fixture manuscript and downloads its EPUB.
- Provenance records the source SHA-256, package part inventory, and importer version; repeated imports of the same bytes are byte-identical through export.
- Synthetic fixtures exercise headings, nested lists, footnotes, endnotes, images with captions, tables, and multilingual text. New files to add: `src/research/docx-import.ts`, `src/research/docx-import.test.ts`, and fixtures under `tests/fixtures/docx/` with a generator script mirroring `tests/fixtures/pdf/generate-fixtures.mjs`. No private manuscripts may be committed.

## Validation command

```bash
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. Parsing runs locally; document bytes, text, and local paths must not be uploaded or logged.

## Artifact outputs

DOCX importer module and tests, importer UI acceptance of `.docx`, synthetic fixture generator and fixtures, provenance and determinism evidence, and EPUB export evidence for the fixture manuscript.

## Stop conditions

Stop before adding a heavyweight DOCX library or native dependency, rendering DOCX through an intermediate PDF, committing private manuscripts as fixtures, or weakening the completeness gate to admit partially parsed documents.

## Human clarification protocol

If OOXML features in scope are ambiguous (tracked changes, comments, content controls, embedded charts), propose the smallest deferral list with named diagnostics for the deferred features rather than silently dropping content.

## Recommended response

Parse `word/document.xml`, `word/footnotes.xml`, `word/endnotes.xml`, and the relationship parts directly with the existing zip and XML tooling; explicit OOXML ids make note and image relationships exact, so this path should reach relationship coverage of 1.0 by construction.

## Trade-offs

A hand-rolled OOXML subset parser covers the scholarly-manuscript features deterministically but will not cover arbitrary Word documents; named fail-closed diagnostics for unsupported features keep the boundary honest, trading breadth for the same inspectability contract as the PDF path.

## Free-form response

The owner's first real acceptance document is a revised humanities manuscript in DOCX with footnotes and figure images; DOCX carries explicit note relationships, so it bypasses the note-matching failures that currently block every corpus PDF and gives the composition and export spine its first end-to-end run on a real paper.
