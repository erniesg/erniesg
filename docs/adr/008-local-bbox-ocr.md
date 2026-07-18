# ADR 008: Local bounding-box OCR for PDF reconstruction

- Status: Accepted
- Date: 2026-07-16

## Context

The PDF reconstruction adapter can recover embedded text but intentionally
fails closed for textless scans, image-only pages, and incomplete mixed pages.
Uploading those pages to a hosted OCR service would disclose document bytes and
recognized text. Accepting OCR as plain prose would also discard the physical
evidence needed to audit reading order, rotation, mixed-text conflicts, and
two-page scans.

OCR therefore has to remain a local, versioned source adapter. It must not turn
uncertain text into a silently exportable publication.

## Decision

PDF.js classifies each physical page from embedded-text geometry, run count,
image count, normalized image coverage, and page shape. Only pages classified
as textless, sparse-text, image-only, or mixed enter OCR. PDF.js renders one
candidate page at a time to a PNG of at most 3,200,000 pixels; the canvas and
PDF.js page are released before the next page proceeds.

The browser lazily loads Tesseract.js from same-origin assets:

| Asset                | Version                                | License    | Published bytes |
| -------------------- | -------------------------------------- | ---------- | --------------: |
| `worker.min.js`      | Tesseract.js 6.0.1                     | Apache-2.0 |         111,162 |
| LSTM core, non-SIMD  | tesseract.js-core 6.1.2                | Apache-2.0 |       3,954,181 |
| LSTM core, SIMD      | tesseract.js-core 6.1.2                | Apache-2.0 |       3,954,569 |
| `eng.traineddata.gz` | tessdata 4.0.0 best-int, package 1.0.0 | MIT        |       2,952,873 |
| **Lazy asset set**   |                                        |            |  **10,972,785** |

Exact package versions and registry integrity hashes are retained in
`package-lock.json`. Astro publishes only those two LSTM cores, the worker, and
the English model at stable `/assets/ocr/` paths, with the worker, engine, core,
and model-package license notices beside them. The application validates all
configured OCR URLs against `window.location.origin` before creating a worker.
There is no hosted OCR fallback and no document text, path, hash, or raster is
sent to telemetry.

The initial language policy exposes `Auto (English fallback)` and explicit
`English`. Auto deterministically selects `eng`; it does not detect, translate,
or rewrite a source language. Any explicit language without an installed local
pack fails before worker creation with `OCR_LANGUAGE_UNAVAILABLE`.

Every recognized page retains:

- engine, engine version, model, model version, language codes, and language
  mode;
- source PDF and rendered-raster SHA-256 hashes;
- physical page number and rotation;
- normalized word and line boxes with confidence; and
- merge disposition for accepted, duplicate, or conflicting OCR words.

Matching embedded text wins over overlapping OCR and the OCR duplicate remains
inspectable evidence. Conflicting overlap remains a blocking diagnostic.
Embedded link annotations are retained without following their URLs. A likely
wide spread can produce left and right logical regions, but both point to the
original physical page. A center-crossing or weak boundary remains uncertain.

OCR confidence below 0.75, mixed-text conflicts, and uncertain spread
boundaries block EPUB and print export for human review. A successful scan is
marked as an OCR-consumed source surface under `ocr-scan-surface-v1`, not
misclassified as a missing semantic figure. That conservative policy selects
only the single largest image covering at least 65% of an OCR-required page,
and only when at least six accepted words, two lines, 40 non-space characters,
and meaningful horizontal and vertical text span fall inside it. Mixed pages,
small labels, unmatched image operators, and every other image remain semantic
assets that block text-only export. The adapter's existing completeness gate
still applies to real figures, tables, equations, relationships, and reading
order.

Cancellation terminates the worker and PDF.js document. Progress is reported
for page extraction and worker recognition. The single-page session and raster
ceiling bound peak working data independently of PDF page count.

## Adding another language

A future language addition requires an explicit change that:

1. pins a repository package version and integrity hash with a compatible
   license;
2. publishes its compressed trained-data file from the same origin;
3. adds its code and human-readable label to the installed-language allowlist;
4. records the model/version choice in OCR provenance; and
5. adds Unicode-preservation, offline-request, confidence, and bundle-size
   evidence before enabling the selector option.

Changing Auto away from the documented English fallback or adding silent
translation requires a new decision record.

## Consequences

Scanned PDFs can now proceed through the same provenance and completeness
pipeline as embedded text while uncertain results remain reviewable. The
default site JavaScript does not eagerly fetch OCR, but the first scan incurs a
material same-origin worker/model cost and device-dependent recognition time.
Only English is operationally installed in this slice; multilingual Unicode is
preserved when an explicit local language session produces it, while an
uninstalled language fails closed.
