# Research Publishing Architecture

## Scope and state

Ernie.SG is the application boundary for the owner's research acquisition,
private reconstruction, editorial work, approval, and delivery. The target is
born-digital academic PDF/DOCX to private reconstruction, review/edit/approve,
then `/research/:slug`, deterministic XHTML, and accessible reflowable EPUB.
Scans and unsupported structures fail closed to
`needs-manual-reconstruction`; no general OCR-quality outcome is promised.

This is a target architecture, not a claim that its lifecycle already exists.
At base `131560e07ef692c27f57acd40a89eaac1f975d62`, current research pages are
`/research` and `/research/[id]`, with source, manifest, and export endpoints
from checked-in `src/research/papers.ts`. The browser importer accepts local
PDF/DOCX, directly fetches a PDF URL in the browser, uses a bounded worker for
PDF reconstruction, and performs DOCX reconstruction from local OOXML/ZIP.

Those current capabilities expose review-required/readiness evidence. Decision
JSON and the 20-paper queue are hash-bound browser/local-first evidence, not a
durable editorial ledger; `publication-ready` in reconstruction materialization
does not mean general public release. The universal publication compiler is a
separate current subsystem with Astro and Payload Lexical build adapters. The
interactive importer does not feed its registry, and the `ResearchPaper`
adapter supports only a limited subset. Existing outputs and `/research`
artifacts demonstrate pieces of the target, not one completed pipeline.

## Target lifecycle

```text
source evidence + private reconstruction
  -> editorial decisions + approved Struct revision
  -> canonical bundle export + Struct verification receipt
  -> authenticated producer export/release record
  -> deterministic XHTML/EPUB + machine/human validation evidence
  -> authenticated approval transition
  -> immutable public release record + /research/:slug delivery
```

Ernie.SG owns source acquisition (local and source-specific URL adapters),
PDF/DOCX extraction, source-specific reconstruction and recovery wording,
editorial decisions, authenticated approval, durable revision/release/export
records, EPUBCheck/Ace/human validation evidence, public route/SEO/RSS/download
delivery, and its UI/storage/provider credentials/deployment.

## Package and consumer boundaries

Struct owns source-neutral semantics, codecs, IDs, ordering, diagnostics, and
deterministic XHTML/reflowable EPUB rendering. The planned bundle protocol is
the only cross-repository wire boundary. Its canonical definition is the
accepted Struct S-01 [package contract][struct-contract] and
[API manifest][struct-api] at exact head
`7b5cf0af273a03d96e97af56c994119073af5812`; this document does not duplicate
that schema. At that head, the private `0.0.0` document/codecs/IDs/recovery/
XHTML/EPUB surface is current, while the bundle, public decoder/verifier,
release, and consumer migration remain documented targets.

Application IDs, Astro/UI state, extractor payloads, source-specific recovery
wording, provider data, credentials, and storage locators do not cross the
Struct boundary. Struct does not own extraction, editorial/release state, UI,
storage, transport, providers, or credentials.

Aether is optional/downstream: it imports only an authenticated, verified,
durably pinned immutable bundle and owns visual composition/derivatives. It can
hold explicit visual or scoped-copy overrides, but cannot mutate or silently
fork canonical Struct text. Semantic changes return to Ernie.SG as a newly
approved revision. Rucksack is generic orchestration/policy/evidence
collection, never the owner of a research domain model, editorial approval,
canonical content, or target credential/mutation authority.

## Integrity, authenticity, and evidence

Struct verification establishes integrity, not producer authenticity. Ernie.SG
must create an authenticated producer export/release record binding canonical
`bundleSha256`, exact approved revision, producer, audience/target, and current
status. Before an external-asset resolver may allocate or start, a consumer
authenticates current, fresh, audience-authorized evidence bound to that digest.
Stale, revoked, wrong-audience, replayed, or digest-mismatched evidence fails
closed before allocation.

Use these labels precisely:

| Label                       | Evidence threshold                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Current**                 | Observed in executable code at base `131560e...`.                                                                                   |
| **Documented target**       | Accepted design intent without implementation proof.                                                                                |
| **Implemented, unreleased** | Exact code and local evidence exist, but no public application/package/artifact release is established.                             |
| **Released/deployed**       | Exact version/OID/artifact digests, authenticated approval/release record, environment/route, and deployment/health evidence exist. |

Docs, configuration, browser storage, local receipts, passing tests, a branch,
or a static page alone do not prove durable approval, release, or deployment.

## Validation and release target

Rendering alone is insufficient. Before public release, the target requires
EPUBCheck, Ace, human review of reading order/navigation/links/text
alternatives/tables/figures/equations/citations/notes, an authenticated approval
transition, and immutable release evidence. The release record must retain
exact approved revision, canonical bundle/document and artifact digests,
package/schema/renderer/profile identities, validation evidence, approver, and
target. Only that record can support public `/research/:slug` delivery.

[struct-contract]: https://github.com/erniesg/struct/blob/7b5cf0af273a03d96e97af56c994119073af5812/CONTRACT.md
[struct-api]: https://github.com/erniesg/struct/blob/7b5cf0af273a03d96e97af56c994119073af5812/API.md
