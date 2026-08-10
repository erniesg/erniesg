# ADR 009: Universal Publication and Capability Contracts

## Status

Accepted for the source-neutral compiler boundary. It introduces contracts only;
it does not move any existing renderer, importer, or studio surface onto them.

## Context

The SRT proof treats a scholarly `ResearchPaper` as the document and a target
profile as the surface. That pairing carried the four-target proof, but it cannot
represent an Astro post, a Payload Lexical document, a DOCX manuscript, or a
repaired PDF without either widening `ResearchPaper` into a de-facto universal
standard or letting each importer invent its own shape.

Two facts from the existing proof constrain the answer. Geometry is output, not
source truth (ADR 001, ADR 003). Reader state resolves semantically and must not
be stored as page rectangles (ADR 007). A universal boundary has to keep both.

## Decision

`src/publication/` holds three versioned contracts and the codecs that police
them. Every contract rejects unknown versions before schema parsing, rejects
extra fields rather than ignoring them, and serialises through one key-sorted
canonical form so equal values always produce equal bytes.

### `PublicationGraph` — `src/publication/schema.ts`

`publicationGraphSchema` version `1.0.0` carries bounded publication metadata,
an ordered `editions` list, and ordered nodes of thirteen types: heading,
paragraph, list, quote, code, figure, caption, table, equation, aside, note,
reference, and media.

Every node records the same medium-independent facts: a stable id, locale and
direction, `required`/`optional` status, editorial importance, source
provenance, accessibility alternatives, authored compact/monochrome/static
variants, permitted transformation ids, explicit reviewed variants, edition
linkage, node-to-node relationships, and content-addressed asset references.

Canonical content forbids target geometry. Every schema object is `.strict()`,
and `findForbiddenCanonicalKeys` additionally refuses keys such as `page`,
`bbox`, `rect`, `x`, `y`, `width`, and `height` anywhere in the node tree. Inline
runs, note references, and backlinks are validated for duplicate ids, dangling
targets, and out-of-range offsets. Only `https:`, `mailto:`, and in-document
fragment URLs are accepted; provenance strings that look like local paths or
secret material are rejected outright.

Edition linkage is explicit rather than inferred. An Astro translation or a
Payload locale is a separate edition whose `translationOf` names the edition it
derives from, and each node names the edition it belongs to.

### `PublicationSourceAdapter` — `src/publication/source-adapter.ts`

A versioned adapter returns `{ version, graph, assetBundle, diagnostics,
provenance }`. `runSourceAdapter` re-validates whatever the adapter produced, so
an adapter cannot promise a contract it does not meet. Cross-checks confirm that
every node asset reference and authored-variant asset exists in the bundle, and
that provenance carries no local path or secret.

### `AssetBundle` — `src/publication/asset-bundle.ts`

Descriptors are bounded and content addressed (`sha256:<hex>`, byte length,
media type, role, provenance). Bytes reach the compiler only through the
bundle's `AssetByteResolver`, and `resolveAssetBytes` proves the content address
and byte length before returning anything. Graph and bundle JSON therefore never
embed bytes, local paths, credentials, or source-specific runtime objects; the
resolver is deliberately excluded from every serialised form.

### `CompositionContext` — `src/publication/profiles.ts`

A context describes continuous or paged flow, logical and derived physical
dimensions with units, margins, orientation, colour capability, resolution,
refresh behaviour, interaction, font control, locale and script, accessibility
preferences, duplex, binding, bleed, offline constraints, and the issue-026
export authority.

`src/research/targets.ts` remains the only registry for dimensions, margins,
orientation, reader-control assumptions, and pagination authority. This module
holds no geometry literal of its own: `toCompositionContext` projects a resolved
`TargetProfile`, and `restoreTargetProfile` rebuilds that exact profile from the
context alone, which is what proves the projection lossless.
`COMPOSITION_CAPABILITY_PRESETS` is data, keyed by profile id, and carries only
the reading-environment capabilities the registry does not own.

### `TransformationPolicy` — `src/publication/transformation-policy.ts`

Each rule declares its representation change, preservation class (`identity`,
`presentation-only`, `representation-substituting`, `meaning-changing`),
legality, any required authored alternative, and hard and soft constraints.

Reflow, repagination, column changes, hyphenation, rescaling, and grayscale
conversion are always legal. Substituting a compact, monochrome, or static
rendition requires that authored variant, reviewed. Omission, summarisation,
reading-order changes, and meaning-changing crops are illegal unless the node
carries an explicit reviewed variant naming that transformation — and a reviewed
variant is only valid when the node also permits the transformation.

### Annotations — `src/publication/annotation-bundle.ts`

Reading anchors, highlights, and notes round-trip in their own versioned bundle
keyed to a graph id and version. `src/research/annotations.ts` remains the single
authority for anchor shape and resolution; this bundle only projects graph text
into that resolver. Annotations never enter the graph, and the `ResearchPaper`
adapter does not pretend those values live on a `ResearchPaper`.

## Migration rules

`src/publication/research-paper-adapter.ts` maps the golden `ResearchPaper` into
the graph and back with identical ids, text, relationships, inline semantics, and
asset references, verified by deep equality, canonical JSON equality, and
`canonicalContentHash` equality.

Mapping rules that are not one-to-one are explicit rather than implied:

- a paragraph carrying list context becomes a `list` node and returns to a
  paragraph with list context;
- a `footnote` becomes a `note` node whose `backlinks` hold note-reference ids;
- `objectType` selects the `figure`, `table`, or `equation` node type, and
  `declaredObjectType` preserves whether the source declared it explicitly;
- `relationships.assets` becomes `assetRefs` with role `primary`.

## Unsupported features

- `figure.table.rows[].cells[].sourceRuns` carries page coordinates. It is
  refused from canonical content and reported as a `dropped-source-geometry`
  diagnostic; `publicationGraphToResearchPaper` cannot invent it back.
- `code`, `aside`, `reference`, and `media` nodes have no `ResearchPaper`
  representation. Converting a graph containing them throws rather than
  silently dropping content.
- A graph without a subtitle or without a caption relationship on an object node
  cannot become a `ResearchPaper`; both throw.
- `http:` and relative URLs are not accepted in canonical content. Sources must
  supply `https:`, `mailto:`, or an in-document fragment.

## Consequences

Source adapters and output adapters can now evolve independently around one
inspectable meaning graph. A rejection is a typed error with a path, not a
best-effort repair, so drift fails validation instead of producing a
plausible-looking rendition. Because assets are content addressed and resolved
lazily, a graph can be inspected, hashed, and transported without its bytes.

The cost is a second document model alongside `ResearchPaper` until importers
move onto it. The compatibility adapter and its round-trip tests are what keep
the two honest in the meantime.

## Non-goals

This decision does not add a renderer, a layout engine, a general optimizer, or
a transformation planner. It does not embed binary assets in graph JSON, does not
duplicate any target or profile fact, does not rename the existing SRT runtime,
and does not let a source adapter smuggle target-specific layout into canonical
nodes. No secret, local path, or target coordinate may enter canonical graph
data.
