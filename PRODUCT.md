# Ernie.SG Product Contract

## Product decision

Ernie.SG is the owner-first Astro site and research-publishing application. It
helps its owner take supported born-digital academic PDF or DOCX material from
source evidence through private reconstruction, review, editing, approval, and
delivery. It is not a journal-management system: it does not make submission,
peer-review, editorial-board, DOI, or other journal operations its product.

The target publishes an approved revision at `/research/:slug` with deterministic
XHTML and accessible reflowable EPUB. Scans and unsupported structures fail
closed to explicit `needs-manual-reconstruction`; this is not a general OCR
quality promise.

## Ownership boundary

Ernie.SG owns local and source-specific URL acquisition; PDF/DOCX extraction;
source-specific reconstruction and recovery wording; editorial decisions;
authenticated approval; durable revision, release, and export records;
EPUBCheck, Ace, and human validation evidence; public routes, SEO, RSS, and
downloads; and its UI, storage, provider credentials, and deployment.

[`@erniesg/struct`][struct-contract] owns only source-neutral document
semantics, codecs, IDs, ordering, diagnostics, and deterministic XHTML and
reflowable EPUB renderers. Its planned bundle protocol is the cross-repository
wire boundary. This contract links the accepted Struct contract rather than
copying a second wire schema: at the accepted Struct S-01 head, private `0.0.0`
document/codecs/IDs/recovery/XHTML/EPUB capabilities are current, while the
bundle, public decoder/verifier, and consumer migration are documented targets.

Rucksack remains generic orchestration, policy, and evidence collection. It
owns no research domain model, editorial approval, canonical content, or target
credential/mutation authority.

Aether is optional and downstream. It may import only an authenticated,
verified, durably pinned immutable bundle and then owns visual composition and
derivatives. It may retain explicit visual or scoped-copy overrides, but cannot
mutate or silently fork canonical Struct text. Semantic corrections return here
as a new approved revision.

## Target lifecycle

The target lifecycle has distinct steps:

1. Source evidence and private reconstruction.
2. Editorial decisions and an approved Struct revision.
3. Canonical bundle export plus a Struct verification receipt.
4. An authenticated producer export/release record.
5. Deterministic render outputs and machine/human validation evidence.
6. An authenticated approval transition.
7. An immutable public release record and `/research/:slug` delivery.

Integrity is not authenticity. The Ernie.SG producer release/export record
binds canonical `bundleSha256`, the exact approved revision, producer,
audience/target, and current status. A consumer authenticates current, fresh,
authorized evidence before any external-asset resolver allocation or start;
unkeyed Struct integrity checks alone cannot establish that authorization.

## Evidence vocabulary

- **Current:** observed in executable code at base
  `131560e07ef692c27f57acd40a89eaac1f975d62`.
- **Documented target:** accepted design intent without implementation proof.
- **Implemented, unreleased:** exact code plus local evidence exists but no
  public application, package, or artifact release is established.
- **Released/deployed:** exact version/OID/artifact digests, an authenticated
  approval/release record, environment/route, and deployment/health evidence
  exist.

Documentation, configuration, browser storage, local receipts, passing tests,
a branch, or a static page alone do not prove durable approval, release, or
deployment.

## Current state and MVP direction

Current routes use `/research` and `/research/[id]`, with source, manifest, and
export endpoints derived from checked-in `src/research/papers.ts`. The browser
importer accepts local PDF and DOCX; direct PDF URLs use browser `fetch`; PDF
reconstruction runs in a bounded worker; and DOCX reconstruction is local
OOXML/ZIP work. These are useful current capabilities with review-required and
readiness evidence, not the target durable editorial or release record.

Decision JSON and the 20-paper review queue are hash-bound browser/local-first
evidence. A `publication-ready` value in reconstruction materialization is not
a general public-release state. The separate universal publication compiler
currently has Astro and Payload Lexical default build adapters; the interactive
PDF/DOCX importer does not feed that registry, and its `ResearchPaper` adapter
has a limited supported subset. Existing renderers and `/research` artifacts
therefore demonstrate components, not a completed target lifecycle.

The first owner-publishing milestone is one supported born-digital paper that
can be privately reconstructed, corrected, approved through durable records,
validated, and released at `/research/:slug` without changing the renderer.

[struct-contract]: https://github.com/erniesg/struct/blob/7b5cf0af273a03d96e97af56c994119073af5812/CONTRACT.md
