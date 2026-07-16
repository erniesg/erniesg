# SRT Target Overrides and Export Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The managed provider branch has read-only Git metadata, so all commit steps are intentionally omitted.

**Goal:** Add one isolated print override and deterministic, inspectable PDF/reflowable export packages without changing canonical research-paper content.

**Architecture:** A strict override module resolves target-and-node-specific presentation patches and hashes only the overrides applicable to each rendition. The layout manifest records that digest, provenance, and layout version. A pure export-package builder assembles deterministic source, layout, annotation, XHTML, EPUB, PDF, manifest, and checksum files; static Astro endpoints expose those files and a verifier checks the package invariants.

**Tech Stack:** TypeScript, Zod, Vitest, Astro static endpoints, `fflate`, Node/Web Crypto APIs.

## Global Constraints

- Do not mutate canonical `ResearchPaper` values.
- Add no hosted, licensed, or nondeterministic export dependency.
- Keep generated export artifacts out of Git and in ignored build/evidence storage.
- Stop before design-tool round-trip or production CMS work.
- Never modify `scripts/agent-evidence`.

---

### Task 1: Isolated target override contract

**Files:**

- Create: `src/research/overrides.ts`
- Modify: `src/research/annotations.ts`
- Modify: `src/research/manifest.ts`
- Test: `src/research/overrides.test.ts`

**Interfaces:**

- Produces: `TargetOverride`, `targetOverrideSchema`, `resolveTargetOverrides(target, node, chosenVariant, overrides)`, and `targetOverrideDigest(overrides)`.
- Produces: `buildLayoutManifest(paper, targets, overrides)` renditions with `layoutVersion` and applied override provenance.
- Consumes: `createLayoutVersion({... overrideDigest })` to make override impact inspectable.

- [ ] **Step 1: Write the failing isolation test**

```ts
const before = buildLayoutManifest(paper)
const after = buildLayoutManifest(paper, LAYOUT_TARGETS, [printOverride])
expect(after.renditions.find(({ target }) => target === 'print')).not.toEqual(
  before.renditions.find(({ target }) => target === 'print'),
)
expect(after.renditions.filter(({ target }) => target !== 'print')).toEqual(
  before.renditions.filter(({ target }) => target !== 'print'),
)
expect(canonicalContentHash(paper)).toBe(sourceHash)
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/research/overrides.test.ts`
Expected: FAIL because `./overrides` and the override-aware manifest API do not exist.

- [ ] **Step 3: Implement the strict override schema and target-local digest**

Create a Zod contract whose patch may replace only `chosenVariant`, whose selector names one `target` and `canonicalId`, and whose provenance records `source` and `reason`. Reject duplicate override IDs and duplicate target/node patches. Hash the stable JSON representation of the overrides after filtering by target.

- [ ] **Step 4: Record applied provenance and layout-version impact**

Extend each rendition with:

```ts
{
  layoutVersion: string,
  overrideSet: {
    digest: string,
    applied: Array<{
      id: string,
      version: string,
      canonicalId: string,
      patch: { chosenVariant: string },
      provenance: { source: string, reason: string },
    }>,
  },
}
```

Validate composition against the override-resolved variant while retaining all existing canonical hash, relationship, pagination, and provenance checks.

- [ ] **Step 5: Verify GREEN**

Run: `npx vitest run src/research/overrides.test.ts src/research/manifest.test.ts src/research/annotations.test.ts`
Expected: PASS with the print rendition changed and the other three byte-equivalent to baseline.

---

### Task 2: Deterministic export package and verifier

**Files:**

- Create: `src/research/export-pdf.ts`
- Create: `src/research/export-package.ts`
- Modify: `src/research/epub.ts`
- Test: `src/research/export-package.test.ts`

**Interfaces:**

- Produces: `buildPaginatedPdf(paper, layoutManifest)` with deterministic A4 PDF bytes and page count.
- Produces: `buildExportPackage(paper, annotations, overrides)` returning named byte files.
- Produces: `verifyExportPackage(exportPackage, paper, annotations, overrides)` returning named passed checks or throwing `ExportVerificationError`.
- Reuses: exported `renderPublicationXhtml(paper)` and `buildEpub(paper)`.

- [ ] **Step 1: Write failing package acceptance tests**

```ts
const first = await buildExportPackage(paper, annotations, [printOverride])
const second = await buildExportPackage(paper, annotations, [printOverride])
expect(first.files).toEqual(second.files)
expect(first.paths()).toEqual([
  'source.json',
  'layout-manifest.json',
  'annotations.json',
  'reflowable.html',
  'publication.epub',
  'print.pdf',
  'export-manifest.json',
  'checksums.sha256',
])
expect(
  verifyExportPackage(first, paper, annotations, [printOverride]),
).toMatchObject({ status: 'passed' })
```

Add negative cases for a missing canonical node, broken relationship, unresolved annotation target, altered checksum, and PDF page-count mismatch.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/research/export-package.test.ts`
Expected: FAIL because the package builder and PDF exporter do not exist.

- [ ] **Step 3: Implement deterministic reflowable and paginated outputs**

Export the existing XHTML renderer from `epub.ts`. Build a minimal local PDF 1.4 file with fixed metadata, A4 page objects matching the print rendition page count, canonical node IDs in its text streams, byte-accurate xref offsets, and no wall-clock values.

- [ ] **Step 4: Assemble manifests and checksums**

Build the six payload files first, write `export-manifest.json` with their media types, sizes, and SHA-256 values plus documented determinism/fidelity limits, then write `checksums.sha256` for every file except itself.

- [ ] **Step 5: Implement fail-closed verification**

Parse and validate source/layout/annotation JSON, compare stable IDs and hashes to the canonical graph, verify relationship targets and annotation resolution, inspect EPUB XHTML IDs, check PDF structure/page count, and recompute manifest/checksum values.

- [ ] **Step 6: Verify GREEN**

Run: `npx vitest run src/research/export-package.test.ts src/research/epub.test.ts`
Expected: PASS for deterministic output and every positive/negative invariant case.

---

### Task 3: Inspectable static exports and repository validation

**Files:**

- Create: `src/pages/research/[id]/exports/[file].ts`
- Modify: `src/components/research/ResearchPaperActions.tsx`
- Modify: `package.json`
- Modify: `docs/issues/007-srt-target-overrides-and-exports.md`

**Interfaces:**

- Consumes: `buildExportPackage` and selects the requested package file in `getStaticPaths`/`GET`.
- Produces: static URLs under `/research/:id/exports/` for every package artifact.
- Produces: `npm run srt:export`, writing generated site/export artifacts to ignored evidence storage.

- [ ] **Step 1: Add one parameterized static export endpoint**

Generate paths only from the known paper IDs and package filenames. Return exact media type, byte body, and attachment/inline disposition; do not accept arbitrary filesystem paths.

- [ ] **Step 2: Link inspectable outputs and document limits**

Link PDF, reflowable HTML, EPUB, source, layout manifest, and export manifest from the paper actions. Document the command, output location, deterministic inputs, fixed timestamps, browser-independent PDF limitation, and the fact that HTML/EPUB is the fidelity reference for reflowable text.

- [ ] **Step 3: Run focused and full validation**

Run:

```bash
npx vitest run src/research/overrides.test.ts src/research/export-package.test.ts
npm test
npm run build
npm run srt:export
infra/vm/verify.sh
scripts/agent-evidence --all
```

Expected: all required repository lanes pass. Record the known VM-service caveat if the sandbox still lacks systemd.

- [ ] **Step 4: Inspect the final working tree**

Run `git diff --check`, `git status --short`, and compare `sha256sum scripts/agent-evidence` with the pre-change value `657013f8ed0bc22d8c7c8c9d56fa7f1a715f3246a7f68ecb9cb8105a9ea8e164`.
