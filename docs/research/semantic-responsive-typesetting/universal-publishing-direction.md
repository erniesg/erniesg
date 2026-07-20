# Universal publishing compiler direction

Status: proposed direction after the PDF-to-EPUB proof of concept. This document
does not claim that the universal compiler or its Astro/Payload adapters are
implemented.

## Decision

Build the next product as a source-first publishing compiler, not as a larger
PDF converter and not as a CMS.

The product promise is:

> Compile one semantic publication into accessible web and EPUB plus paged-print
> compositions while preserving required meaning and explaining every material
> transformation.

`ernie.sg` is the first authoring and dogfood surface. Astro content and, later,
Payload rich-text documents are input adapters. PDF reconstruction remains a
lossy adapter with provenance and human repair; it must never become the
canonical authoring model.

Rucksack remains the engineering, evaluation, and release fleet. It can build
and benchmark this product, but universal publishing is not part of Rucksack's
core product category or its active harness-loop issue graph.

## Current truth

The repository already proves useful pieces:

- one canonical `ResearchPaper` can compose into mobile, A4, Paper Pro, and
  Paper Pro Move previews;
- finite pagination, stable node ids, reading anchors, annotations, target
  policies, manifests, EPUB packaging, and deterministic fixture evidence
  exist;
- local PDF and DOCX adapters feed the research-paper graph;
- PDF import has completeness gates, source evidence, diagnostic overlays, and
  replayable human decisions for note and reading-order ambiguity;
- DOCX preserves explicit inline formatting, links, notes, images, and tables;
- matched PDF figures, tables, and equations can carry source-backed rendition
  assets into EPUB.

The current system is not yet a universal compiler:

- `ResearchPaper` is a scholarly proof schema, not a source-neutral publication
  intermediate representation;
- profile ids still name four products/use cases rather than arbitrary
  capability profiles;
- browser preview, EPUB composition, and print/PDF generation do not consume
  one renderer-neutral layout plan;
- the finite paginator estimates text and figure geometry instead of shaping
  and measuring the actual selected assets and fonts;
- PDF text reconstruction does not populate inline runs and has no explicit
  line-end dehyphenation decision model;
- visual-match diagnostics have no legal human adjudication path;
- Payload is not present in this repository;
- the engineering benchmark covers one trusted eleven-node fixture and cannot
  support a broad quality or market claim.

## PDF-ingestion product gate

The lossy PDF adapter may advance only when its outputs behave like semantic publications rather than enlarged PDF columns. Component contracts live in issues 012, 013, 018, and 023-026; issue 032 binds them into the privacy-safe `2408.10903v5` regression.

Promotion requires measurable evidence that inline bold/italic/super/subscript/link/citation/note semantics and relative hierarchy survive; section headings require geometry plus syntax; lists/references/bibliography remain typed; discretionary wrap hyphens disappear while lexical compounds survive; no isolated glyph, duplicate small-cap, table-row, or equation-glyph debris enters prose; captions remain complete and anchored to source-backed diagrams/figures/tables/equations; and ambiguous objects remain review-required. Mobile and e-ink output must follow canonical one-stream reading order rather than imitate PDF columns.

The upload studio must discard stale state and reprocess every fresh file, then show checked Mobile, Paper Pro Move (`954 × 1696`), and Paper Pro (`1620 × 2160`) previews before optional matching-profile downloads. The same graph, profile version, relationships, and artifact hash bind preview and download receipts. Generated redistributable fixtures gate CI; private/named papers contribute only hashes, aggregate metrics, normalized boxes, codes, versions, timings, and verdicts, never source bytes/text, local paths, screenshots, traces, or unpacked artifacts in Git or GitHub.

## Architecture

```text
Astro MD/MDX ─┐
Payload JSON ─┼─> PublicationSourceAdapter ─> PublicationBundle
DOCX ─────────┤       │                         graph + assets
PDF (lossy) ──┘       └─ diagnostics + provenance       │
                                                         v
                                             CompositionContext
                                             + TransformationPolicy
                                                         │
                                                         v
                                               deterministic planner
                                                         │
                                               static semantic preflight
                                                         │
                                                         v
                                                 candidate LayoutPlan
                                                         │
                                                   renderer probe
                                                         │
                                          geometric/production validation
                                                         │
                                      ┌──────────────────┼────────────────┐
                                      v                  v                v
                                responsive WebPub   reflowable EPUB   paged PDF
                                      └──────────────────┼────────────────┘
                                                         v
                                               PublicationReceipt
```

### PublicationGraph

The canonical graph stores meaning, relationships, alternatives, and source
evidence rather than page coordinates. The initial node set should cover
headings, paragraphs, lists, quotes, code, figures, captions, tables,
equations, asides, notes, references, and media.

Every node has a stable id, canonical reading order, locale/direction,
required-or-optional status, editorial importance, accessibility alternative,
source provenance, and permitted authored representations. Compact text,
monochrome art, and audio descriptions are authored variants. A model-generated
summary or description is a proposed variant with model/prompt provenance, not
silent source truth.

The source boundary is a versioned `PublicationSourceAdapter` returning a
`PublicationBundle`: graph, content-addressed asset descriptors, a bounded byte
resolver, diagnostics, and provenance. Renderers receive only that bundle and
never import Astro, Payload, DOCX, or PDF types. Linked editions—Astro
translations and Payload locales—are explicit relationships rather than mixed
language fallbacks.

### CompositionContext

Profiles describe capabilities and production constraints, not device brands:

```yaml
flow: paged | continuous
size: { width: 148mm, height: 210mm }
orientation: portrait | landscape
color: full | limited | monochrome
resolution_dpi: 300
refresh: static | slow | fast
interaction: none | keys | touch | pointer
font_control: publisher | reader
duplex: true
binding: left
bleed: 3mm
language: en
```

Named presets such as A4, A5, six-inch monochrome e-ink, or broadsheet are
versioned profile files built on this contract. Custom dimensions use the same
schema. “Any size” means required information remains reachable and legible;
it does not mean identical geometry or simultaneous visibility at every size.
The current `TargetProfile` registry and its orientation/export authority must
map losslessly into this contract during migration; dimensions, margins, and
pagination facts cannot acquire a second source of truth.

### TransformationPolicy

Each component declares legitimate representations and hard preservation
rules. Examples include table to stacked records, chart to patterned
monochrome, interactive graphic to an authored static alternative, and margin
aside to endnote. Omission, summarization, changed reading order, or a crop that
can change meaning is never an implicit layout operation.

The planner chooses among bounded composition modes such as editorial spread,
conventional page, compact page, single-column reading, and sequence. It does
not continuously invent a different design at every pixel.

### Eligibility before aesthetics

The preflight gate rejects a candidate before aesthetic ranking when any of
these fail:

- required content is unreachable;
- canonical reading order or a required relationship is broken;
- text falls below the profile's legibility floor;
- content clips or overflows unexpectedly;
- a figure/caption, note/reference, table, or equation becomes unusable;
- a required accessible or monochrome alternative is missing;
- font shaping, glyph coverage, hyphenation, or language-specific line breaking
  is unresolved;
- source resolution, bleed, binding, or other production constraints fail.

Only eligible candidates can be compared for page count, density, hierarchy,
asset prominence, whitespace, and other soft preferences. Human review is
needed when no eligible candidate exists or a material editorial trade-off is
not covered by standing policy.

Eligibility has two stages. Static semantic preflight rejects an invalid plan
before layout. A pinned renderer then measures a bounded candidate and returns
page count, glyph, overflow, clipping, and relationship geometry evidence.
Geometric and production validation must pass before that draft becomes a
final artifact. A planner cannot know shaped line breaks or final page geometry
without this renderer feedback loop.

## Renderer strategy

Do not write another paged-media engine for the first source-first release.

Vivliostyle CLI already accepts HTML and Markdown and can produce WebPub, EPUB,
and PDF. It supports frontend static builds, custom page dimensions, crop marks,
and bleed. Use it behind a pinned renderer adapter for the first Astro
vertical slice, with repository-owned CSS themes and no runtime theme download.
Keep the adapter replaceable because EPUB reading systems may ignore or override
publisher flow and typography, and print production may later require stronger
PDF/X, CMYK, font, imposition, or RIP integration.

The renderer toolchain includes pinned Vivliostyle, browser, font, and EPUBCheck
versions/checksums. Compiler build and check lanes must run in CI and the local
evidence script; a locally successful optional command is not a release gate.

CSS Paged Media supplies page size, orientation, margin boxes, running matter,
page counters, marks, and bleed. EPUB remains a delivery format, not the
canonical graph: reflowable EPUB is designed for dynamic layout, and reading
systems can override requested flow behavior.

References:

- [Vivliostyle CLI output and input matrix](https://docs.vivliostyle.org/en/cli/getting-started/)
- [Vivliostyle frontend static-build support](https://docs.vivliostyle.org/en/cli/frontend-framework-support/)
- [Vivliostyle page sizes, crop marks, and bleed](https://docs.vivliostyle.org/en/cli/themes-and-css/)
- [CSS Paged Media Level 3](https://www.w3.org/TR/css-page-3/)
- [EPUB 3.3](https://www.w3.org/TR/epub-33/)
- [EPUB Reading Systems 3.3](https://www.w3.org/TR/epub-rs-33/)

## Source adapters

### Astro beachhead

Astro content collections already provide validated entries, raw Markdown/MDX
bodies, and rendered content. The first user journey is one existing English
blog post compiled by id into:

- the existing responsive Astro page;
- a WebPub package;
- a reflowable EPUB;
- A4 and A5 paged PDFs from repository-owned themes;
- a receipt binding source hash, graph version, profile, policy, renderer, and
  artifact checksums.

The adapter must fail closed on unsupported MDX components instead of dropping
them. Images, code, math, footnotes, links, headings, language, and publication
metadata must survive. Translations are separate source editions linked by the
existing translation key; they are not silently combined.

Reference: [Astro Content Collections API](https://docs.astro.build/en/reference/modules/astro-content/).

### Payload follow-on

Payload rich text is stored as typed Lexical JSON and can be converted to HTML,
plain text, Markdown, or MDX. A Payload adapter should map that JSON directly to
the same `PublicationGraph`, including blocks, uploads, relationships, locale,
and authored alternatives. It must not add a Payload-specific renderer branch.

Start with committed synthetic Lexical fixtures and an adapter contract. Add an
opt-in Local API or REST reader later; authentication values remain outside
issues, logs, fixtures, and receipts.

References:

- [Payload rich-text field](https://payloadcms.com/docs/fields/rich-text)
- [Payload Lexical converters](https://payloadcms.com/docs/rich-text/converters)
- [Payload Local API](https://payloadcms.com/docs/local-api/overview)

## Delivery sequence

1. Make the current import preview truthful and finish its unresolved repair
   paths. This prevents the proof UI from teaching a false source/output model.
2. Introduce versioned `PublicationGraph`, `CompositionContext`, and
   `TransformationPolicy` codecs, plus an adapter from the existing
   `ResearchPaper` fixture.
3. Ship one published Astro-post compiler journey plus a feature-complete
   synthetic fixture through a pinned Vivliostyle adapter to WebPub, EPUB, A4
   PDF, and A5 PDF.
4. In parallel, add the two-stage semantic/renderer planner and the Payload
   Lexical adapter, proving that the same output adapters consume both sources
   without branching.
5. Add source-to-output mapping and scoped editorial locks in a multi-profile
   preview matrix over checked artifacts and receipts.
6. Expand the corpus and profile library before broader “magazine,” “book,” or
   “newspaper” claims. Add production-print gates separately.

## Claim boundary

The first release may claim “one semantic source, three output formats, four
reference profiles” only when exact-head checks render and validate this matrix:
phone WebPub, monochrome e-ink EPUB, A5 PDF, and A4 PDF. After the Payload slice,
the gate must also prove Astro and Payload bundles traverse identical output
adapters with matching renderer/profile/policy identifiers. The responsive
Astro route remains the existing web edition in the first slice; it is a sibling
from the same source, not yet a graph-rendered output.

The release may not claim arbitrary-PDF fidelity, universal aesthetic
optimization, production newspaper imposition, tagged PDF/PDF-UA, PDF/X
compliance, CMYK fidelity, or support for every future surface without separate
evidence.
