# ADR 009: Universal publication and capability contracts

## Status

Accepted for the first source-neutral compiler boundary.

## Context

The research proof has a useful `ResearchPaper` schema and an authoritative
target-profile registry, but neither is a universal publication source.
`ResearchPaper` is intentionally scholarly, while rendered pages and recovered
PDF coordinates are rendition or source evidence. Astro translations, Payload
locales, DOCX manuscripts, and repaired PDFs need one bounded meaning graph
without promoting any one source runtime or target geometry into canonical
content.

## Decision

`PublicationGraph` version `1.0.0` is the source-neutral compiler input. Its
strict codec admits ordered heading, paragraph, list, quote, code, figure,
caption, table, equation, aside, note, reference, and media nodes. Stable ids,
explicit relationships, edition linkage, locale and direction, requirement,
editorial importance, provenance, accessibility alternatives, authored
variants, and permitted transformation ids are carried on the graph. Unknown
versions or fields, duplicate ids, dangling relationships, unsafe URLs,
unbounded values, invalid ranges, local paths, and secret-shaped source values
fail closed. Page coordinates are not graph fields.

A `PublicationSourceAdapter` returns `{ graph, assetBundle, diagnostics,
provenance }`. Asset descriptors are bounded and content-addressed. Bytes remain
behind an asynchronous resolver and cannot be serialized into graph JSON.
Source adapters may report unsupported features through diagnostics; they may
not retain local paths, credentials, source-specific runtime objects, or target
layout state in the graph.

`CompositionContext` version `1.0.0` describes flow, logical and physical
dimensions, orientation, color, resolution, refresh, interaction, font
control, locale and script, accessibility preferences, duplex, binding, bleed,
offline constraints, reader control, and pagination authority. Named presets
are derived data. `src/research/targets.ts` remains the only registry for target
dimensions, margins, orientation, reader assumptions, and pagination
authority. The adapters in `src/publication/profiles.ts` validate that a context
still equals its named registry profile before converting it back.

`TransformationPolicy` version `1.0.0` declares representation changes,
preservation classes, authored-alternative requirements, and hard or soft
constraints. Omission, summarization, reading-order changes, and
meaning-changing crops are invalid unless they point to an explicit reviewed
authored variant.

The first `ResearchPaper` adapter is deliberately thin. It round-trips the two
existing golden papers' common heading, paragraph, quote, figure, and caption
subset, including canonical ids, text, inline semantics, figure/caption
relationships, and asset ids. Annotations and semantic anchors use a separately
versioned `AnnotationBundle`; cached layout rectangles remain non-canonical
annotation data. Structured scholarly tables/equations, legacy list context,
embedded note references, and extended scholarly affiliation/lineage metadata
produce explicit unsupported errors until a source-neutral mapping is reviewed.

## Versioning and migration

Codecs accept only their declared version. Additive fields still require a new
contract version because strict decoding would otherwise make producers and
consumers disagree. A migration must parse the complete old value, explicitly
map every changed field, validate the new value, and preserve stable ids,
edition links, relationships, asset hashes, and annotation anchors. Silently
dropping unknown data is forbidden.

Canonical receipts bind serialized graph and asset-descriptor hashes to the
graph, asset, profile, and adapter versions plus the repository's evidence
manifest and toolchain versions. Receipt generation belongs to exact-head
validation rather than these codecs; graph serialization itself is
byte-deterministic for a validated in-memory value.

## Consequences

Importers and output compilers can evolve independently around a small,
inspectable boundary. Source and target details remain recoverable at their
typed edges rather than expanding the graph into an abstract document
standard. Unsupported input fails visibly instead of being approximated.

## Non-goals

This decision does not add a renderer, optimizer, paged-media engine, general
document standard, binary asset store, network fetcher, PDF geometry model, or
source-runtime bridge. It does not migrate the existing SRT runtime, duplicate
the target registry, promise lossless conversion for unlisted
`ResearchPaper` extensions, or permit target coordinates in canonical graph
data.
