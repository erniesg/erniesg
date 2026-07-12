# SRT finite-height pagination and fragmentation

depends-on: 004

## Provider

vm-codex

## Goal

Implement explainable finite-height composition for A4 and e-ink targets with fragmentation, keep rules, and explicit fallbacks.

## Acceptance tests

- Width and finite height are independent constraints.
- Paragraphs may fragment; headings, captions, figures, and atomic objects obey declared keep/split policies.
- No clipping, overlap, silent loss, orphaned caption, or unexplained overflow occurs in the golden set.
- Manifest records page, fragment lineage, placement decision, violations, and fallback reason.
- Current-region stability is measured separately from final page count.

## Validation command

```bash
npm test
npm run build
scripts/agent-evidence --e2e
```

## Allowed secrets

None.

## Artifact outputs

Pagination engine/policy, fragmentation tests, manifests, screenshots, and pagination ADR.

## Stop conditions

Stop if the chosen paged-media engine cannot expose enough geometry or decision evidence without an architectural change.

## Human clarification protocol

Document the engine limitation, alternatives, migration cost, and recommended bounded experiment.

## Recommended response

Own the semantic policy and manifest while delegating measurement and basic fragmentation to browser or paged-media machinery.

## Trade-offs

Custom pagination offers control but is costly; browser delegation is faster but may need explicit diagnostic adapters.

## Free-form response

Complex tables and equations may use declared atomic visual fallbacks.
