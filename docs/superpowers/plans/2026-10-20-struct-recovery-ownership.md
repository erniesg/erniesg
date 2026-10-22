# E-03 recovery ownership preparation — 2026-10-20

**Status:** PREPARATION only. This is not completed E-03 and makes no package API,
writer, Bundle, renderer, or public-route claim.

## Baseline and scope

- App base: `453fb256` on `chore/struct-migration-audit-20261020` (clean at the
  start of this preparation).
- Owned implementation: application recovery/UI wording moves from portable
  `src/struct/recovery.ts` to app-owned `src/struct-adapters/recovery.ts`.
- The moved implementation is byte-for-byte the current module except that its
  type import uses the public `@erniesg/struct/document` contract.
- `src/struct/recovery.ts` becomes a compatibility-only forwarding seam that
  exports the same runtime functions and `RecoveryDiagnosticInput` type.
- `src/struct/index.ts` keeps exporting `./recovery`, so the root compatibility
  barrel continues to expose the same function identities.
- Production consumers outside portable `src/struct` import the app-owned
  adapter:
  - `src/struct-adapters/from-reconstruction.ts`
  - `src/research/recovery-projection.ts`
  - `src/components/research/PublicationImporter.tsx`
- Portable codec, renderer, EPUB, identity, and ordering implementations are not
  changed. No frozen expected file is regenerated. PR450's inline hyperlink
  logic is untouched.

## Intended behavior

Runtime strings, diagnostic copy, grouping, sorting, fallback behavior, and
recovery object shapes are unchanged. Passing the same input to the legacy path
or the app-owned path returns the same values, and their exported functions are
the same objects because the legacy path only re-exports the adapter.

The boundary test permits exactly one new portable seam: `src/struct/recovery.ts`
may forward from `../struct-adapters/recovery`. Any other portable module that
imports app-owned recovery remains a violation, mirroring the existing
`from-reconstruction` exception. The boundary also asserts that production
modules outside `src/struct` do not import the legacy recovery path.

## Files

- New: `src/struct-adapters/recovery.ts`
- Compatibility shim: `src/struct/recovery.ts`
- Production import updates in the three consumers listed above
- Boundary tests: `tests/struct-adapter-boundary.test.ts`
- This preparation record

## Validation

- `npx vitest run tests/struct-adapter-boundary.test.ts --maxWorkers=1`
- `npx vitest run tests/struct-adapter-parity.test.ts tests/struct-adapter-parity.freeze.test.ts --maxWorkers=1`
- `npx vitest run tests/struct-package-parity.test.ts tests/struct-package-artifact.test.ts --maxWorkers=1`
- `npx vitest run src/struct/struct.test.ts src/research/recovery-projection.test.ts --maxWorkers=1`

The red-first boundary test is added and observed failing before the move. The
frozen adapter parity fixtures stay unchanged and must remain green.

## Remaining gates and rollback

This preparation does not complete E-03. It does not switch to
`@erniesg/struct/recovery`, delete the local compatibility file, activate a
writer, or claim integrated evidence. Revert this preparation commit to restore
the previous ownership location; no durable data or route changes are involved.
