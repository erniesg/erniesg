# Add bbox-preserving OCR for scanned, mixed, and two-page PDFs

depends-on: 012

## Provider

vm-codex

## Goal

Add a local, versioned OCR path for scanned and mixed PDFs that emits word/line boxes and confidence into the same source graph, detects two-page scan spreads, and supports explicit human review without uploading documents.

## Acceptance tests

- Detect textless, sparse-text, mixed, and image-only pages using evidence stronger than a single character-count threshold.
- Run OCR locally in a worker with cancellation, progress, bounded memory, and no network requests.
- Record OCR engine/model/language versions, per-word/line bounding boxes, confidence, page rotation, and source hashes.
- Detect likely two-page spreads and split their logical regions while retaining the original physical-page provenance.
- Merge embedded text and OCR output without duplicating text or losing embedded links; conflicts remain diagnostics.
- Support explicit language selection and a documented automatic-language fallback without silently translating content.
- Low-confidence OCR, uncertain spread boundaries, and mixed-page conflicts enter review and block final export.
- Synthetic fixtures cover a scan, rotated scan, mixed page, multilingual page, two-page spread, and cancellation/resource cleanup.
- The previously textless class proceeds through OCR while the no-OCR configuration still fails closed.

## Validation command

```bash
npm test
npm run build
npm run test:e2e -- tests/e2e/publication-importer.spec.ts
scripts/agent-evidence --all
git diff --check
```

## Allowed secrets

None. OCR must run locally; document bytes, OCR text, and local paths must not be uploaded or written to telemetry.

## Artifact outputs

OCR worker/integration, versioned provenance, spread detector, merge policy, review diagnostics, synthetic fixtures, performance/resource evidence, and privacy tests.

## Stop conditions

Stop before adding a hosted OCR dependency, downloading model weights without an explicit integrity/licensing policy, logging document content, or auto-accepting low-confidence text.

## Human clarification protocol

If the local OCR engine or model introduces material bundle size, license, language, or device-support trade-offs, present the smallest viable choices with measured costs.

## Recommended response

Keep OCR behind the same source-evidence contract as embedded text, run it off the UI thread, and make uncertainty reviewable.

## Trade-offs

Local OCR protects privacy and supports offline use but increases bundle/runtime cost; a lazy-loaded, integrity-pinned worker keeps the default site lightweight.

## Free-form response

The audited scanned book used two-page image spreads and produced zero embedded text across all 18 PDF pages, which the current pipeline correctly rejected but cannot reconstruct.
