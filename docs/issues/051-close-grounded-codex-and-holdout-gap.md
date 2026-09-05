# Close the grounded-Codex and holdout gap in staged PDF-to-EPUB

provider: vm-codex
depends-on: 041,046

## Goal

Close the truth and promotion-evidence gap between the staged browser-local
PDF-to-EPUB experiment and the verified owner-local grounded-Codex pipeline,
without uploading private papers or weakening semantic release gates.

## Acceptance tests

- Browser-local PDF conversion is explicitly identified as deterministic and
  not Codex-assisted. Without a verified grounded-refinement receipt it can
  produce only a readable review artifact, never a publication-grade EPUB.
- DOCX publication behavior remains unchanged.
- The synthetic extraction bakeoff carries machine-validated authority fields
  proving it made no real provider calls and is promotion-ineligible.
- Benchmark readiness requires exact-artifact evidence from Apple Books, an
  independent desktop EPUB reader, and a target e-ink reader/device. Browser
  XHTML rendering cannot satisfy any native-reader requirement.
- Current unavailable native-reader states and missing private blind-test data
  remain blockers. No checked-in result is relabelled ready.
- A later owner-local execution must bind source, evidence graph, MinerU,
  Codex, exact EPUB, comparator, and EPUBCheck identities before it can satisfy
  the real-provider criterion.

## Validation command

```bash
npx vitest run src/components/research/PublicationImporter.test.tsx
npx vitest run tools/pdf-extraction-bakeoff.test.mjs tools/pdf-benchmark-readiness.test.mjs --maxWorkers=1
npm test
npm run build
scripts/agent-evidence
```

## Allowed secrets

None for this code slice. Real owner-local evidence remains a separate trusted
VM execution and must not put source bytes, prompts, credentials, or private
labels in GitHub.

## Artifact outputs

Fail-closed staging copy/export behavior, synthetic-authority metadata, native
reader readiness fields and validators, focused regressions, and exact-head
evidence. GitHub tracking issue: #290.

## Stop conditions

Stop before adding hosted private-document upload, an API-key path, Cloudflare
resource provisioning, paper-specific parser branches, holdout replacement,
or any promotion claim based only on package/browser validity.
