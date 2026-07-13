# ADR 004: Local PDF reconstruction and reflowable EPUB export

## Status

Accepted for the born-digital vertical slice. Scanned-page OCR and full EPUBCheck automation remain explicit follow-up work.

## Context

PDF stores marks in a fixed page coordinate system. The SRT canonical graph must instead preserve semantic nodes, stable identity, relationships, and provenance while keeping target geometry in renditions. Treating PDF coordinates as canonical layout would make mobile and e-ink output another brittle page repair.

## Decision

- Open PDF bytes only in the browser with PDF.js. No document, extracted text, or source box is uploaded.
- Retain page number, rotation, font evidence, and normalized top-left bounding boxes for every extracted text run.
- Reconstruct lines and blocks deterministically. Source boxes remain a separate provenance map keyed by canonical node ID; they never enter canonical target geometry.
- Classify each page from measured embedded-text coverage and image operators. Pages below the embedded-text threshold emit `OCR_REQUIRED`; a document with any such page cannot export a partial EPUB.
- Remove repeated margin text only when the same normalized pattern appears on at least two pages. Keep the decision as an inspectable diagnostic.
- Package canonical nodes into a reflowable EPUB 3 container with an uncompressed first `mimetype` entry, container document, package metadata, navigation, spine, XHTML, conservative e-ink CSS, and an export manifest.
- Fix ZIP timestamps to the earliest portable ZIP date so the same canonical input produces the same archive bytes and checksum.

## Coordinate systems

PDF.js text transforms are mapped through the rotated page viewport, converted to a top-left origin, and normalized to `[0, 1]` page coordinates. These coordinates are evidence for reconstruction and human review. Mobile, Paper Pro, Paper Pro Move, and A4 measurements remain target-profile data and are never inferred back into the source graph.

## Privacy and security

The route is static and local-only. It accepts PDFs up to 50 MB, rejects non-PDF input, refuses password-protected input, disables PDF JavaScript evaluation, and does not add a server upload path. Generated EPUB blob URLs live only for the browser session. No secret or write token is involved.

## Generated-file and dependency notes

- `pdfjs-dist` is Apache-2.0 and contributes a lazy PDF parser chunk plus an approximately 1.1 MB worker asset; neither is needed for ordinary research reading.
- `fflate` is MIT and packages the EPUB in-browser.
- Disposable PDFs, EPUBs, screenshots, and source maps belong in `.agent/evidence/`, CI artifacts, or temporary validation directories—not in published source content.
- Structural ZIP/XML validation runs now. EPUBCheck 5.3.0 should be pinned in the follow-up conformance issue because the local environment currently has no Java runtime.

## Consequences

Born-digital scholarly PDFs now have a one-gesture local path to inspectable semantic content and a real `.epub`. Scanned or mixed documents with missing embedded text stop visibly instead of producing incomplete books. Local OCR must later normalize into the same source-box schema; it must not change the canonical/rendition boundary.
