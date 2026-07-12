# Semantic Responsive Typesetting

## Literature Review + Research-Gap Handoff

**Companion to:** Semantic Responsive Typesetting PRD + Agent Handoff v0.1  
**Review type:** Targeted scoping review  
**Coverage:** Adaptive document composition, PDF reconstruction, scholarly reading, e-ink, annotation persistence, and relevant standards  
**Prepared:** 12 July 2026

> **Core finding:** The individual capabilities are not new. Adaptive document layout, PDF-to-EPUB conversion, scientific-paper reflow, document reconstruction, and annotation repositioning all have substantial prior art. The credible opportunity is their integration into a fidelity-constrained system where one semantic document graph produces multiple finite-height renditions while preserving provenance, reading position, and annotations.

[PAGE BREAK]

## 0. How to use this document

This review is a companion to the product requirements document, not a replacement for a formal systematic review. It is intended to let a fresh research or implementation agent answer four practical questions quickly:

1. **What has already been demonstrated?**
2. **Which claims would be weak or historically inaccurate?**
3. **Where is the apparent integrated research gap?**
4. **Which literature-derived decisions should constrain the proof of concept?**

The review deliberately separates the **demonstrator domain** from the **product thesis**:

- The demonstrator is scholarly papers rendered for A4, large e-ink, small/tall e-ink, and continuous digital reading.
- The thesis is **Semantic Responsive Typesetting (SRT):** a semantic, constraint-based composition architecture in which pages and coordinates are generated renditions rather than the canonical document.

The short handoff for a new agent is in Section 14. The annotated reading list is in Section 15. A machine-importable BibTeX file accompanies this review.

## 1. Executive synthesis

The broad problem is not “unsolved” in the sense that nobody has attempted dynamic document layout. It is **split across research lineages that optimize for different goals**.

| Claim | What the literature shows | Consequence for the POC |
|---|---|---|
| Documents can adapt to different displays | Adaptive grid and document-layout systems demonstrated this in the early 2000s; newer systems support multiple responsive factors and optimization. | Do not claim the first adaptive or responsive document system. |
| PDFs can be converted or reflowed | PDF-to-EPUB book conversion appeared in 2011; a 2013 system reflowed scientific papers for e-book readers and translated annotations. | Do not frame novelty as PDF-to-EPUB or one-column reflow. |
| Scholarly PDFs can be reconstructed | GROBID-like pipelines, PubLayNet, S2ORC, SciA11y, DocLayNet, VILA, Nougat, Docling, and MinerU make structured recovery increasingly practical. | Use existing extraction components; do not make OCR the core contribution. |
| Annotation anchors can survive change | Robust anchoring and digital-ink reflow were studied from 2001 onward; Web Annotation now provides a standard selector model. | Start with semantic text anchors; treat arbitrary ink transformation as a separate research problem. |
| E-ink can support serious reading | Studies find paper-like eye-movement behaviour and less visual fatigue than LCD in some conditions, while academic reading studies expose navigation and annotation limitations. | The key comparison is representation × viewport geometry, not “e-ink versus paper” alone. |
| Standards provide most low-level primitives | JATS supplies scholarly semantics; HTML/CSS supply layout and fragmentation; EPUB supplies reflowable packaging; Web Annotation supplies target selectors. | Own a thin domain schema and policy layer rather than inventing a complete format stack. |

The strongest apparent gap is therefore not any one component. It is the full loop:

```text
structured or reconstructed scholarly source
        ↓
canonical semantic graph with provenance
        ↓
constraint-based composition across width and finite height
        ↓
A4 / large e-ink / small e-ink / continuous digital renditions
        ↓
stable reading anchors and annotations
        ↓
engineering and active-reading evaluation
```

A defensible research claim is:

> We design and evaluate an integrated semantic composition architecture that generates multiple faithful, paginated renditions from one canonical scholarly document while preserving object identity, source provenance, reading position, and annotation targets.

The words **integrated**, **faithful**, **finite-height**, **persistent**, and **evaluated** matter. Removing them collapses the contribution into well-established prior art.

## 2. Scope, method, and limits

### 2.1 Review questions

This targeted review asked:

- **LRQ1:** What prior work exists on adaptive, responsive, or constraint-based document layout?
- **LRQ2:** What prior work exists on PDF-to-EPUB conversion and scientific-paper reflow?
- **LRQ3:** How mature is semantic reconstruction of scholarly PDFs?
- **LRQ4:** What is known about academic reading on e-readers and differently sized displays?
- **LRQ5:** How have annotations been anchored or reflowed as documents change?
- **LRQ6:** Which standards can serve as implementation substrates?
- **LRQ7:** What combination of capabilities appears insufficiently integrated or evaluated?

### 2.2 Search approach

Sources were identified through targeted searches of ACM Digital Library, IEEE/ICDAR records, ACL Anthology, arXiv, Springer, PLOS, W3C, NISO, institutional research pages, and citation chaining from landmark work. Search concepts included combinations of:

```text
adaptive document layout
responsive document authoring
automatic document formatting
PDF to EPUB
scientific paper reflow e-book reader
scholarly PDF structured extraction
accessible scientific HTML
responsive pagination
reflowing annotations / digital ink
academic reading e-reader screen size
JATS EPUB Web Annotation
```

The review prioritizes primary papers, official standards, and official project reports. It covers landmark work through 12 July 2026.

### 2.3 Inclusion and exclusion

Included work had a direct bearing on at least one of these layers:

- semantic document representation;
- PDF or image reconstruction;
- automatic composition and pagination;
- responsive authoring across targets;
- scholarly or active reading;
- annotation anchoring across document change;
- interoperable publication standards.

Excluded work included generic responsive-web tutorials, pure OCR papers without structural implications, commercial product pages without technical evidence, and layout-generation research focused only on isolated posters or slides.

### 2.4 Limitations

This is not a PRISMA review and does not establish an exhaustive “first.” It has not yet performed duplicate screening across bibliographic databases, formal quality scoring, complete backward/forward snowballing, or publication-bias analysis. Accordingly, the gap language in this document is **“apparent gap”** and **“I did not identify”**, not “no prior system exists.”

Before publication, the project should run a reproducible systematic search using Scopus/Web of Science, ACM, IEEE Xplore, ACL Anthology, and Google Scholar; preserve exact queries; screen abstracts in duplicate; and update citation status.

## 3. Terminology and conceptual frame

### 3.1 Responsive typography is too narrow

In common web practice, *responsive typography* or *responsive typesetting* can refer primarily to font size, line length, leading, and scale. The proposed system also recomputes component arrangement, columns, fragmentation, page boundaries, figure placement, and reader state.

### 3.2 Adaptive document layout is the established lineage

“Adaptive document layout” is a historically grounded research term. Jacobs and colleagues used it for systems that automatically reformatted, resized, and paginated text and graphics across different display conditions. “Automatic document formatting” is a broader survey term. “Responsive document authoring” and “ultra-responsive documents” appear in newer HCI work.

### 3.3 Recommended project term

**Semantic Responsive Typesetting** is a suitable project term because it adds the architectural property that ordinary responsive design often lacks:

> Semantic Responsive Typesetting is the constraint-based recomposition of persistent text and visual components across different page and viewport dimensions while preserving identity, relationships, provenance, and reader state.

This definition distinguishes the project from simple scaling and from free-form “movable” objects. Movement is governed by relationships and policy:

```text
caption stays with figure
heading stays with following content
figure may span one or two columns
table has a minimum usable width
annotation remains attached to a semantic target
```

### 3.4 The page is a compiled rendition

The core model is:

```text
canonical semantic graph
+ target profile
+ composition policy
+ target-specific overrides
= computed rendition
```

The page number, glyph boxes, columns, and coordinates are cacheable outputs. The document’s paragraphs, figures, captions, references, and annotation targets remain persistent.

## 4. Adaptive document layout and automatic composition

### 4.1 Early adaptive layout systems

Jacobs et al. (2003) introduced **Adaptive Grid-Based Document Layout**, representing a visual style as a family of grid templates that could adapt to page sizes and viewing conditions. Their 2004 **Adaptive Document Layout** article generalized the question: how can text and graphics be reformatted, resized, and paginated for displays of different sizes?

This work establishes several ideas central to SRT:

- layout is generated from a representation plus templates or constraints;
- visual style can survive changes in available space;
- pagination is part of the adaptive problem;
- global composition differs from independently resizing components.

Schrier et al. (2008) extended adaptive layout to dynamically aggregated documents. Hurst, Li, and Marriott’s 2009 review showed that automatic formatting was already a substantial field spanning line breaking, tables, diagrams, page composition, templates, and optimization.

**Novelty consequence:** “The same content can be laid out for different dimensions” is not a new research claim. The POC needs a more specific contribution: persistent semantics, faithful scholarly content, finite-height recomposition, source provenance, and annotation continuity.

### 4.2 Responsive authoring systems

DocDancer (Chen et al., 2023) is especially relevant. It supports “ultra-responsive” documents where both content and layout can respond to multiple factors such as screen width, font properties, and customer segments. It uses a unified representation and offers layout generation/recommendations. Its user studies reported lower authoring time and effort than a commercial responsive-design tool.

FlexDoc (Jiang et al., 2024) combines discrete and continuous optimization to adapt layout and content across devices, author preferences, and viewer needs. It demonstrates that a modern system can treat adaptation as an optimization problem rather than a fixed set of breakpoints.

These systems validate the broader product intuition, but they do not automatically close the SRT gap:

- their examples include marketing, news, and academic material, but not necessarily fidelity-critical long-form scholarly pagination;
- content adaptation may include summarization or image carving, which is risky for scientific claims and figures;
- annotation persistence and source-PDF provenance are not their central problem;
- they do not establish the exact representation × e-ink-geometry experiment proposed here.

### 4.3 What the composition literature implies

The composition engine should distinguish:

- **local component adaptation:** compact versus expanded figure, one- versus two-column span, inline versus sidebar;
- **global flow:** line breaking, page breaks, float placement, widows/orphans, and cascading movement;
- **discrete choices:** component variant, column count, page placement;
- **continuous choices:** widths, heights, spacing, scale;
- **hard constraints:** no content loss, caption stays associated, minimum type size;
- **soft constraints:** visual balance, preferred figure proximity, preferred page count.

The POC does not need a universal optimizer, but it should make this separation visible in its architecture and layout manifest.

## 5. PDF-to-EPUB conversion and scientific-paper reflow

### 5.1 PDF-to-EPUB is established prior art

Marinai, Marino, and Soda (2011) described PDF-to-EPUB conversion as reversing the formatting imposed during pagination. Their system used layout analysis to recover structures including chapters, paragraphs, notes, illustrations, and a table of contents. The paper explicitly recognized tables, equations, and bibliographic material as difficult.

This is a direct ancestor of the proposed ingestion path. It also states the key architectural problem clearly: a structured source such as XML or LaTeX can generate multiple outputs naturally, while a camera-ready PDF must be reverse-engineered.

### 5.2 The closest predecessor: scientific reflow with annotations

Marinai (2013) addressed multi-column scientific PDFs on e-book readers with limited computation. The tool produced a modified single-column PDF using document-image processing and translated free-form annotations from the reformatted document back to the original.

It is close enough that the project must discuss it prominently. The differences that preserve room for a modern contribution are:

1. The output was primarily a **geometric rearrangement of page regions**, not a rich canonical semantic article graph.
2. The system produced another fixed PDF, not a family of responsive renditions generated from persistent semantics.
3. The annotation mapping depended on correspondence between fixed regions; it did not provide a general semantic selector architecture.
4. It did not evaluate a controlled cross-product of representation and substantially different e-ink geometries.
5. It predates modern document-intelligence models, standards, and interactive scholarly-reading systems.

### 5.3 Accessible HTML as a modern adjacent path

SciA11y (Wang et al., 2021) reconstructed scientific PDFs into accessible HTML. In an analysis of 11,397 scientific PDFs, only 2.4% met all defined accessibility criteria. Its generated HTML added headings, navigation, and bidirectional citation links; 87% of evaluated renders had no or only some readability issues.

SciA11y is important because accessible HTML and responsive e-ink reading share the same prerequisite: logical reading structure must be recoverable independently of fixed page geometry.

### 5.4 Implication for the POC

A weak POC would be:

```text
PDF page blocks → one-column PDF
```

A stronger POC is:

```text
structured source or reconstructed PDF
→ canonical semantic graph
→ multiple responsive renditions
→ provenance and persistent annotations
```

PDF ingestion should remain an adapter. The first composition demonstration should use a manually checked JATS-derived or equivalent fixture so extraction errors do not obscure the composition thesis.

## 6. Scholarly-document reconstruction and document intelligence

### 6.1 Structured extraction is materially more feasible now

The modern pipeline can build on a mature ecosystem:

- **PubLayNet** (Zhong et al., 2019) aligned PDF and XML representations from more than one million PubMed Central papers, producing over 360,000 annotated document images.
- **S2ORC** (Lo et al., 2020) demonstrated structured scholarly content at scale, linking inline citations, figures, and tables to their objects.
- **DocLayNet** (Pfitzmann et al., 2022) added 80,863 manually annotated pages across diverse document categories and eleven layout classes; baseline models remained roughly ten percentage points below inter-annotator agreement.
- **VILA** (Shen et al., 2022) explicitly modeled layout groups such as lines and blocks for scientific-PDF structure extraction.
- **Nougat** (Blecher et al., 2023) generated markup from document images, targeting semantic losses such as mathematical expressions.
- **Docling** (Auer et al., 2024) converts documents into a unified structured representation using layout and table-recognition models.
- **MinerU** (Wang et al., 2024) combines models with preprocessing and postprocessing to extract heterogeneous document content into structured outputs.

These projects reduce the cost of creating a PDF adapter. They do not make reconstruction infallible.

### 6.2 Error propagation remains a product risk

Layout and semantic errors cascade:

```text
wrong block boundary
→ wrong paragraph or heading
→ wrong reading order
→ wrong figure association
→ wrong pagination
→ wrong annotation target
```

DocLayNet’s human–model gap is a useful warning. A high bounding-box score does not guarantee a coherent reading experience.

### 6.3 Objects are insufficient without relationships

A parser may identify a figure and a caption without knowing that they belong together. SRT needs relations such as:

```text
caption describes figure
body sentence refers to figure
footnote belongs to text range
equation number identifies equation
citation marker links to reference
annotation targets exact semantic range
```

This makes the canonical model a **graph**, not a flat list of blocks. Evaluation should separately score:

- block classification;
- reading order;
- hierarchy;
- figure–caption association;
- reference links;
- provenance mapping;
- rendition usability.

### 6.4 Structured source should remain the preferred path

The ingestion priority should be:

```text
JATS/XML or trusted CMS data
→ LaTeX/HTML source
→ born-digital PDF reconstruction
→ scanned PDF reconstruction
```

This is not merely an engineering convenience. It preserves the product thesis that semantics should exist upstream rather than be repeatedly inferred downstream.

## 7. Standards and implementation substrates

### 7.1 JATS for scholarly semantics

JATS 1.4 (ANSI/NISO Z39.96-2024) provides a standardized vocabulary for journal-article text and graphics. It already models much of the ontology required by the POC: front matter, sections, figures, captions, tables, equations, notes, citations, and references.

The POC does not need to expose raw JATS to every component. A validated JSON graph inspired by JATS is reasonable, provided the mapping is documented and IDs remain stable.

### 7.2 HTML/CSS for composition

HTML and CSS provide a practical rendering substrate:

- Grid and Flexbox for local layout;
- container/media queries for component adaptation;
- CSS Fragmentation for pages and columns;
- Paged Media features for page size, margins, headers, and footers;
- MathML/SVG/images for scientific objects.

The renderer still needs a policy layer. CSS cannot infer editorial intent that has not been encoded.

### 7.3 EPUB as a delivery rendition

EPUB 3.3 packages XHTML, CSS, images, SVG, and MathML and supports reflowable content. It is appropriate as a delivery format, not as the canonical model. PDF and EPUB should be sibling outputs:

```text
canonical article graph
├── paginated print PDF
├── device-paginated HTML view
├── reflowable EPUB
└── continuous web rendition
```

### 7.4 Web Annotation and EPUB Annotations

The W3C Web Annotation Data Model represents annotations using bodies, targets, and selectors. This supports the desired rule that a highlight’s canonical location is a semantic text range, while rectangles are derived geometry.

The EPUB Annotations 1.0 Working Draft, published in 2026, profiles annotation concepts for EPUB resources. Its draft status means it should be treated as design guidance rather than a fixed production dependency.

### 7.5 Standards-derived architectural decision

The project should **own meaning and policy, not reimplement standards**:

- adopt JATS concepts;
- render with HTML/CSS and a paged-media engine;
- package EPUB when needed;
- model annotations with Web Annotation-like selectors;
- retain source-PDF coordinates as provenance, not canonical position.

## 8. E-ink, screen geometry, and active scholarly reading

### 8.1 E-ink itself is not necessarily the problem

Siegenthaler et al. (2011) found broadly similar eye-movement behaviour between print and the e-ink display they tested. Benedetto et al. (2013) found greater subjective visual fatigue for LCD than for e-ink or paper in prolonged reading, although not every physiological measure differed.

These studies suggest that an uncomfortable scientific-PDF experience on a small e-ink device may be caused less by e-ink as a medium and more by fitting a fixed, paper-shaped layout into an incompatible viewport.

### 8.2 Academic reading is active and spatial

Thayer et al. (2011) studied graduate students using a Kindle DX for academic work. The study is relevant because scholarly reading includes more than linear comprehension:

- scanning and skimming;
- comparing distant passages;
- moving between text and figures;
- following citations;
- annotating;
- returning to remembered spatial locations.

The Semantic Reader Project (Lo et al., 2024) likewise treats conventional PDFs as a substrate that can be augmented with interactive interfaces. Its line of work reinforces the importance of document structure and cross-object navigation, even though it does not focus on responsive e-ink pagination.

### 8.3 Screen size and movement are interacting variables

Haverkamp et al. (2023) compared smartphone versus tablet reading and scrolling versus paging. They found no statistically significant main effect of screen size on integrated understanding, but navigation patterns and subjective experience differed by movement mode and device combination.

This supports a more precise experiment than “large screen versus small screen.” The SRT study should manipulate:

```text
representation
  - original fixed PDF
  - geometrically optimized single-column PDF
  - semantic responsive rendition

× viewport geometry
  - large paper-like e-ink
  - small tall/narrow e-ink
```

The interaction is the interesting hypothesis: semantic recomposition may matter most when the fixed page and device geometry are badly mismatched.

### 8.4 The direct empirical gap

In this targeted search, I did not identify a peer-reviewed controlled study that jointly compares fixed scholarly PDF, geometric reflow, and semantic reflow across markedly different e-ink geometries while measuring comprehension, navigation, figure integration, annotation, and reading-position continuity.

That is an apparent gap, not yet a verified first-ever claim.

## 9. Annotation persistence across reflow

### 9.1 A long research lineage

XLibris and related active-reading systems established free-form digital ink as a core reading interaction. Brush et al. (2001) studied robust annotation positioning when documents change. Golovchinsky and Denoue’s **Moving Markup** (2002) repositioned free-form annotations across changes in font, font size, aspect ratio, and device. Bargeron and Moscovich’s **Reflowing Digital Ink Annotations** (2003) examined how ink should move when the underlying document reflows.

Sutherland, Luxton-Reilly, and Plimmer’s mapping study (2016) found that much digital-ink research still concerned static documents and that changing text remained difficult.

### 9.2 Text highlights are the tractable P0

A highlight can be represented by:

```text
semantic node ID
+ exact text range
+ quote
+ prefix/suffix context
+ optional source-PDF coordinates
```

Its page rectangles are derived from the current layout. This aligns with the Web Annotation selector model.

### 9.3 Freehand ink is semantically ambiguous

A stroke may be:

- an underline attached to a line of text;
- a circle around several lines;
- an arrow relating two objects;
- a margin note attached to a paragraph but spatially offset;
- a page-level diagram with no clear textual anchor.

A layout change may alter line count, aspect ratio, and relative positions. Translation or uniform scaling is often insufficient.

The POC should therefore sequence annotation work:

1. text highlights;
2. anchored text notes;
3. paragraph-relative margin notes;
4. constrained freehand underlines;
5. arbitrary multi-object ink as a research extension.

### 9.4 Annotation evaluation

Annotation persistence needs more than a screenshot. Measure:

- exact text-target survival;
- target ambiguity after edits;
- geometric displacement from intended object;
- confidence/fallback status;
- reader success in relocating the annotation;
- subjective acceptability of transformed ink.

## 10. Cross-strand evidence map

The following map summarizes what each lineage contributes. “Strong” means the capability is central; “partial” means it is present but limited or indirect.

| Literature strand | Semantic source/recovery | Width + finite-height recomposition | Provenance or persistent identity | Annotation continuity | Active-reading evaluation |
|---|---|---|---|---|---|
| Adaptive document layout | Strong structured-input assumption | Strong | Partial | Weak | Partial |
| PDF-to-EPUB / scientific reflow | Partial | Partial to strong | Partial geometric mapping | Partial | Weak |
| Modern document intelligence | Strong recovery focus | Weak | Partial | Weak | Weak |
| Responsive authoring/optimization | Strong | Strong | Partial unified models | Weak | Authoring-focused |
| E-reader and scholarly-reading HCI | Weak | Weak | Weak | Partial interaction studies | Strong |
| Annotation anchoring/reflow | Partial | Partial | Strong target focus | Strong | Strong for annotation behaviour |
| Standards | Strong vocabulary | Strong primitives | Strong identifiers/selectors | Strong model | None by themselves |

No single strand supplies the complete architecture. The POC’s value is to make the joins explicit and testable.

## 11. Apparent research gap and novelty guardrails

### 11.1 Gap statement

A precise gap statement is:

> Existing work separately addresses adaptive document layout, scholarly-PDF reconstruction, scientific-paper reflow, e-reader interaction, and annotation repositioning. This review did not identify a system that integrates all five into a provenance-preserving semantic composition architecture and evaluates it across heterogeneous e-ink page geometries during active scholarly reading.

The proposed integration includes:

1. a canonical scholarly graph;
2. stable semantic IDs and source provenance;
3. responsive composition across width and finite height;
4. multiple paginated and continuous targets;
5. hybrid semantic/visual fallbacks for complex objects;
6. persistent reading and annotation anchors;
7. inspectable layout decisions and target-specific overrides;
8. optional progressive or viewport-first composition;
9. engineering and human-subject evaluation.

### 11.2 Claims to avoid

Do not claim:

- the first PDF-to-EPUB converter;
- the first scientific-paper reflow system;
- the first adaptive or responsive document layout;
- the first annotation system that survives layout change;
- the first semantic scholarly reader;
- perfect reconstruction of arbitrary PDFs;
- that screen size alone causes the observed experience.

### 11.3 Defensible contribution claims

Potential claims, subject to implementation and formal review, include:

- a unified canonical model connecting semantic nodes, source-PDF provenance, generated renditions, and annotations;
- a fidelity-constrained responsive pagination policy for scholarly documents;
- a systematic comparison of original PDF, geometric reflow, and semantic recomposition across contrasting e-ink geometries;
- an annotation persistence model evaluated under device and typography changes;
- a progressive-composition strategy evaluated by time to first stable reading region and anchor stability;
- evidence about which scientific objects should be semantically reflowed versus preserved as visual fallbacks.

### 11.4 Product thesis versus paper contribution

The long-term product thesis is broad:

> structured content and visual components should remain semantically connected while geometry is compiled for each target.

A research paper needs a narrower falsifiable contribution. Scholarly e-ink reading is a good benchmark because it combines long-form prose, finite pages, cross-references, figures, equations, tables, and annotations.

## 12. Literature-derived product requirements

These requirements should be added to or checked against the PRD.

| ID | Requirement | Literature rationale |
|---|---|---|
| LR-01 | Canonical content must not be page coordinates. | Adaptive-layout and PDF-reconstruction work both expose the cost of early flattening. |
| LR-02 | Every rendered object must retain a stable semantic ID. | Required for provenance, overrides, reading anchors, and annotations. |
| LR-03 | The model must represent relationships, not only block classes. | Figure/caption/reference coherence cannot be recovered from object detection alone. |
| LR-04 | The first POC must use a trusted structured fixture. | Modern parsers are useful but imperfect; extraction errors would confound composition evaluation. |
| LR-05 | PDF ingestion must emit confidence and provenance. | Reconstruction errors cascade into layout and annotation failures. |
| LR-06 | Width and finite height must be separate constraints. | Continuous responsive web layout does not solve fragmentation and pagination. |
| LR-07 | The renderer must support hybrid fallbacks. | Tables, equations, and multi-panel figures are not all safely reflowable. |
| LR-08 | Scholarly mode must prohibit silent summarization or content deletion. | Optimization systems that alter content are not automatically appropriate for fidelity-critical reading. |
| LR-09 | Text annotations must use semantic selectors; geometry is a cache. | Annotation-reflow research and Web Annotation support this architecture. |
| LR-10 | Freehand ink must be scoped separately from text highlights. | Ink attachment semantics are ambiguous under major reflow. |
| LR-11 | Evaluation must measure active reading, not only visual quality. | Academic reading includes navigation, comparison, and annotation. |
| LR-12 | Representation and viewport geometry must be crossed experimentally. | Screen size, movement mode, and layout interact. |
| LR-13 | Progressive composition must preserve a stable semantic reading anchor. | Fast first display is not useful if later pagination causes disruptive jumps. |
| LR-14 | The layout manifest must explain decisions and fallbacks. | The POC’s general value is governed recomposition, not opaque rendering. |

## 13. Recommended research design

### 13.1 Research questions

**RQ1 — Composition correctness**  
Can one canonical semantic graph generate coherent renditions across A4, large 4:3 e-ink, small tall e-ink, and continuous mobile targets without losing content identity or relationships?

**RQ2 — Representation × geometry**  
How do original PDF, geometrically optimized PDF, and semantic responsive rendition affect comprehension, navigation, workload, and interaction across large and small e-ink geometries?

**RQ3 — Hybrid rendering**  
Which scholarly content classes can be safely reflowed, and which require preserved visual or dedicated interactive fallbacks?

**RQ4 — Annotation continuity**  
How accurately and acceptably can text highlights, anchored notes, and constrained freehand ink persist across typography, viewport, and pagination changes?

**RQ5 — Progressive composition**  
Can viewport-first composition reduce perceived delay while preserving reading-position and annotation stability as distant content is paginated?

### 13.2 Phase A: engineering evaluation

Use one golden paper and a stratified regression corpus:

```text
prose-heavy
figure-heavy
table-heavy
equation-heavy
mixed complex layout
```

Prefer papers with JATS or LaTeX ground truth. Evaluate:

- semantic-node coverage;
- reading order and hierarchy;
- figure–caption and citation–reference links;
- exact source-provenance mapping;
- overflow, clipping, and constraint violations;
- content-preservation checksums;
- stable IDs across targets;
- annotation target survival;
- total composition time and time to first stable viewport.

### 13.3 Phase B: active-reading study

A counterbalanced within-participant design can cross:

| Factor | Conditions |
|---|---|
| Representation | Original PDF / optimized single-column PDF / semantic responsive rendition |
| Geometry | Large paper-like e-ink / small tall e-ink |
| Task | Read / locate / compare / figure-text integration / annotate / resume after reflow |

Measures should include:

- comprehension and retrieval accuracy;
- task time;
- pan, zoom, page-turn, and backtracking events;
- figure-to-text navigation time;
- annotation creation and relocation time;
- anchor error after reflow;
- workload and comfort;
- trust in rendition fidelity;
- preference, with reasons.

### 13.4 Control the device confound

Commercial devices differ in more than screen size: aspect ratio, resolution, weight, refresh behaviour, input latency, and software. Use two stages if resources permit:

1. controlled geometry simulation using the same renderer and interaction environment;
2. ecological validation on the physical e-ink devices.

This separates the effect of viewport geometry from the effect of the entire product.

## 14. Fresh-agent handoff

### 14.1 Read these first

1. **Marinai (2013), Reflowing and Annotating Scientific Papers on eBook Readers** — closest predecessor and mandatory prior-art discussion.
2. **Jacobs et al. (2004), Adaptive Document Layout** — establishes the broad adaptive-layout lineage.
3. **Hurst, Li, and Marriott (2009), Review of Automatic Document Formatting** — maps the older field.
4. **Wang et al. (2021), SciA11y** — modern PDF-to-structured-HTML precedent and evaluation model.
5. **Chen et al. (2023), DocDancer** and **Jiang et al. (2024), FlexDoc** — current responsive authoring/optimization precedents.
6. **Brush et al. (2001), Moving Markup (2002), and Reflowing Digital Ink Annotations (2003)** — anchor and ink continuity foundations.
7. **Haverkamp et al. (2023)** and **Thayer et al. (2011)** — reading/task design.
8. **JATS, EPUB, CSS Fragmentation, and Web Annotation** — implementation substrate.

### 14.2 First-week research tasks

- Create a one-page comparison of Marinai 2013 versus the proposed architecture.
- Confirm that no newer peer-reviewed system combines semantic multipage recomposition, e-ink form-factor comparison, and annotation persistence.
- Select one openly licensed paper with trusted JATS or LaTeX source and a matching PDF.
- Define the canonical graph and provenance mapping before selecting a PDF parser.
- Reproduce at least one baseline: original PDF and simple single-column geometric reflow.
- Define “faithfulness” as testable invariants, not a visual impression.
- Decide which complex objects remain atomic in P0.
- Add citation keys from the accompanying BibTeX file to the repository.

### 14.3 Questions the agent must resolve

- Is pagination performed by a browser/CSS engine, a dedicated paged-media renderer, or a custom fragmentation layer?
- Which decisions are declarative policy versus engine behaviour?
- How is a stable reading anchor represented across line and page changes?
- What is the fallback when a parser cannot confidently associate a caption or reference?
- How is designer intent recorded: new coordinates, a target-specific rule, or an override with scope?
- Does progressive pagination expose provisional page numbers, percentages, semantic locations, or chapter positions?
- What constitutes a “stable” layout region for latency evaluation?

### 14.4 Recommended repository evidence folder

```text
/research
  /papers
    README.md              # citation key, status, relevance, notes
  /prior-art
    marinai-2013-comparison.md
    capability-matrix.md
  /protocols
    search-protocol.md
    engineering-evaluation.md
    user-study-outline.md
  references.bib
```

### 14.5 Formal-review search strings

Use variations of:

```text
("adaptive document layout" OR "responsive document" OR "automatic document formatting")
AND (pagination OR typesetting OR composition)

(PDF OR "scientific paper")
AND (reflow OR "EPUB conversion" OR "responsive reading")
AND (ebook OR "e-ink" OR tablet)

(annotation OR "digital ink" OR highlight)
AND (reflow OR responsive OR "document change")

("scholarly PDF" OR "scientific document")
AND (semantic extraction OR structured HTML OR JATS)
```

Record exact database syntax, dates, result counts, screening decisions, and backward/forward citations.

## 15. Annotated core bibliography

### 15.1 Adaptive layout and composition

**Jacobs, Li, Schrier, Bargeron, and Salesin (2003), “Adaptive Grid-Based Document Layout.”**  
A foundational template/grid approach for adapting document style to different display conditions. Use it to position SRT within automatic composition rather than ordinary responsive CSS.

**Jacobs et al. (2004), “Adaptive Document Layout.”**  
The clearest early articulation of dynamically reformatting, resizing, and paginating text and graphics across displays. It prevents overclaiming the general concept.

**Schrier et al. (2008), “Adaptive Layout for Dynamically Aggregated Documents.”**  
Demonstrates adaptive composition for content assembled dynamically. Relevant to data-driven publishing and the user’s current workflow.

**Hurst, Li, and Marriott (2009), “Review of Automatic Document Formatting.”**  
A useful map of line breaking, page composition, tables, diagrams, templates, and optimization. Read before defining the engine as a wholly new category.

**Chen et al. (2023), “DocDancer: Authoring Ultra-Responsive Documents with Layout Generation.”**  
A contemporary authoring system where layout and content respond to multiple factors. Important for the unified-model and designer-workflow aspects of the POC.

**Jiang et al. (2024), “FlexDoc.”**  
Shows joint discrete/continuous optimization of content and layout. Its summarization and image-carving strategies are useful contrasts for SRT’s fidelity-constrained scholarly mode.

### 15.2 PDF reconstruction and reflow

**Marinai, Marino, and Soda (2011), “Conversion of PDF Books in ePub Format.”**  
Direct PDF-to-EPUB prior art. Frames conversion as reversing pagination and recovering structure.

**Marinai (2013), “Reflowing and Annotating Scientific Papers on eBook Readers.”**  
The closest direct predecessor: single-column scientific-paper reflow for e-book readers plus annotation mapping. The new work must differentiate itself explicitly.

**Wang et al. (2021), “SciA11y: Converting Scientific Papers to Accessible HTML.”**  
A modern system-level precedent for reconstructing scholarly PDFs into a semantic reading representation, with accessibility-centered evaluation.

### 15.3 Document intelligence

**Zhong, Tang, and Jimeno Yepes (2019), “PubLayNet.”**  
Large-scale PDF/XML alignment for document-layout analysis. Supports the idea of using structured publisher data as ground truth.

**Lo et al. (2020), “S2ORC.”**  
Demonstrates large-scale scholarly records with linked citations, figures, and tables. Useful as a model for canonical relationships.

**Pfitzmann et al. (2022), “DocLayNet.”**  
A diverse human-annotated layout dataset. Its remaining gap to human agreement is a reminder to expose confidence and fallback behaviour.

**Shen et al. (2022), “VILA.”**  
Treats lines and blocks as visual-layout groups for structured extraction. Relevant to reconstructing paragraph and section structure from PDFs.

**Blecher et al. (2023), “Nougat.”**  
A visual-to-markup model designed for academic documents and mathematics. Useful for equation-rich inputs, but not a complete composition architecture.

**Auer et al. (2024), “Docling Technical Report.”**  
An open-source conversion toolkit producing a unified rich representation. A practical candidate for the later PDF adapter.

**Wang et al. (2024), “MinerU.”**  
An open-source extraction pipeline combining models and rules across diverse documents. Another practical ingestion candidate.

### 15.4 Reading and annotation

**Thayer et al. (2011), “The Imposition and Superimposition of Digital Reading Technology.”**  
A long-term qualitative study of graduate students using a Kindle DX. Useful for defining active-reading tasks and compensatory behaviours.

**Siegenthaler et al. (2011), “Comparing Reading Processes on E-Ink Displays and Print.”**  
Shows that e-ink can support broadly print-like eye-movement patterns, helping isolate layout mismatch from display-medium effects.

**Benedetto et al. (2013), “E-Readers and Visual Fatigue.”**  
Compares paper, e-ink, and LCD in prolonged reading. Useful background, but not evidence about responsive scholarly layout.

**Haverkamp et al. (2023), “Is It the Size, the Movement, or Both?”**  
Directly motivates crossing viewport size with paging/scrolling or representation rather than treating screen size as a single independent cause.

**Lo et al. (2024), “The Semantic Reader Project.”**  
A major modern program augmenting scholarly PDFs with interactive reading interfaces. Adjacent evidence for semantic navigation and active-reading design.

**Brush et al. (2001), “Robust Annotation Positioning in Digital Documents.”**  
A foundation for anchoring annotations to content that may change.

**Golovchinsky and Denoue (2002), “Moving Markup.”**  
Demonstrates free-form annotation repositioning across font, size, aspect-ratio, and device changes.

**Bargeron and Moscovich (2003), “Reflowing Digital Ink Annotations.”**  
Studies the difficult case where the underlying text reflows and handwriting must be transformed or reassigned.

**Sutherland, Luxton-Reilly, and Plimmer (2016), systematic mapping study.**  
Shows that changing documents remain less well covered than static annotation scenarios.

### 15.5 Standards

**JATS 1.4 (ANSI/NISO Z39.96-2024).**  
The strongest off-the-shelf semantic vocabulary for journal articles. Use as the conceptual base for the canonical graph.

**EPUB 3.3.**  
A reflowable delivery standard built on web technologies. Treat EPUB as a rendition, not the source of truth.

**CSS Fragmentation Module Level 3.**  
Defines the model for partitioning content flow across pages and columns. Central to finite-height responsive composition.

**W3C Web Annotation Data Model.**  
Provides the target/selector architecture for portable semantic annotations.

**EPUB Annotations 1.0 Working Draft.**  
A current, draft bridge between Web Annotation and EPUB. Useful for design alignment, but its status should be tracked.

## 16. Full references

Auer, C., Lysak, M., Nassar, A., Dolfi, M., Livathinos, N., Vagenas, P., et al. (2024). *Docling Technical Report*. arXiv:2408.09869. https://doi.org/10.48550/arXiv.2408.09869

Bargeron, D., & Moscovich, T. (2003). Reflowing digital ink annotations. In *Proceedings of CHI ’03* (pp. 385–393). https://doi.org/10.1145/642611.642678

Benedetto, S., Drai-Zerbib, V., Pedrotti, M., Tissier, G., & Baccino, T. (2013). E-readers and visual fatigue. *PLOS ONE, 8*(12), e83676. https://doi.org/10.1371/journal.pone.0083676

Blecher, L., Cucurull, G., Scialom, T., & Stojnic, R. (2023). *Nougat: Neural Optical Understanding for Academic Documents*. arXiv:2308.13418. https://doi.org/10.48550/arXiv.2308.13418

Brush, A. J. B., Bargeron, D., Gupta, A., & Cadiz, J. J. (2001). Robust annotation positioning in digital documents. In *Proceedings of CHI ’01* (pp. 285–292). https://doi.org/10.1145/365024.365117

Chen, Y., Liu, Z., Tensmeyer, C., Elmqvist, N., & Morariu, V. I. (2023). DocDancer: Authoring ultra-responsive documents with layout generation. In *2023 IEEE Symposium on Visual Languages and Human-Centric Computing* (pp. 133–138). https://doi.org/10.1109/VL-HCC57772.2023.00023

Golovchinsky, G., & Denoue, L. (2002). Moving markup: Repositioning freeform annotations. In *Proceedings of UIST ’02* (pp. 21–30). https://doi.org/10.1145/571985.571989

Haverkamp, Y. E., Bråten, I., Latini, N., & Salmerón, L. (2023). Is it the size, the movement, or both? Investigating effects of screen size and text movement on processing, understanding, and motivation when students read informational text. *Reading and Writing, 36*, 1589–1608. https://doi.org/10.1007/s11145-022-10328-9

Hurst, N., Li, W., & Marriott, K. (2009). Review of automatic document formatting. In *Proceedings of the 2009 ACM Symposium on Document Engineering* (pp. 99–108). https://doi.org/10.1145/1600193.1600217

Jacobs, C., Li, W., Schrier, E., Bargeron, D., & Salesin, D. (2003). Adaptive grid-based document layout. *ACM Transactions on Graphics, 22*(3), 838–847. https://doi.org/10.1145/882262.882353

Jacobs, C., Li, W., Schrier, E., Bargeron, D., & Salesin, D. (2004). Adaptive document layout. *Communications of the ACM, 47*(8), 60–66. https://doi.org/10.1145/1012037.1012063

Jiang, Y., Lutteroth, C., Jain, R., Tensmeyer, C., Manjunatha, V., Stuerzlinger, W., & Morariu, V. I. (2024). *FlexDoc: Flexible Document Adaptation through Optimizing both Content and Layout*. arXiv:2410.15504. https://doi.org/10.48550/arXiv.2410.15504

Lo, K., Wang, L. L., Neumann, M., Kinney, R., & Weld, D. S. (2020). S2ORC: The Semantic Scholar Open Research Corpus. In *Proceedings of ACL 2020* (pp. 4969–4983). https://doi.org/10.18653/v1/2020.acl-main.447

Lo, K., Chang, J. C., Head, A., Bragg, J., Zhang, A. X., Trier, C., et al. (2024). The Semantic Reader Project: Augmenting scholarly documents through AI-powered interactive reading interfaces. *Communications of the ACM, 67*(10), 50–61. https://doi.org/10.1145/3659096

Marinai, S. (2013). Reflowing and annotating scientific papers on eBook readers. In *Proceedings of the 2013 ACM Symposium on Document Engineering* (pp. 241–244). https://doi.org/10.1145/2494266.2494311

Marinai, S., Marino, E., & Soda, G. (2011). Conversion of PDF books in ePub format. In *2011 International Conference on Document Analysis and Recognition* (pp. 478–482). https://doi.org/10.1109/ICDAR.2011.102

National Information Standards Organization. (2024). *ANSI/NISO Z39.96-2024: Journal Article Tag Suite (JATS), Version 1.4*. https://doi.org/10.3789/ansi.niso.z39.96-2024

Pfitzmann, B., Auer, C., Dolfi, M., Nassar, A. S., & Staar, P. W. J. (2022). DocLayNet: A large human-annotated dataset for document-layout segmentation. In *Proceedings of KDD ’22* (pp. 3743–3751). https://doi.org/10.1145/3534678.3539043

Schilit, B. N., Golovchinsky, G., & Price, M. N. (1998). Beyond paper: Supporting active reading with free form digital ink annotations. In *Proceedings of CHI ’98*.

Schrier, E., Dontcheva, M., Jacobs, C. E., Wade, G., & Salesin, D. (2008). Adaptive layout for dynamically aggregated documents. In *Proceedings of IUI ’08* (pp. 99–108). https://doi.org/10.1145/1378773.1378787

Shen, Z., Lo, K., Wang, L. L., Kuehl, B., Weld, D. S., & Downey, D. (2022). VILA: Improving structured content extraction from scientific PDFs using visual layout groups. *Transactions of the Association for Computational Linguistics, 10*, 376–392. https://doi.org/10.1162/tacl_a_00466

Siegenthaler, E., Wurtz, P., Bergamin, P., & Groner, R. (2011). Comparing reading processes on e-ink displays and print. *Displays, 32*(5), 268–273. https://doi.org/10.1016/j.displa.2011.05.005

Sutherland, C. J., Luxton-Reilly, A., & Plimmer, B. (2016). Freeform digital ink annotations in electronic documents: A systematic mapping study. *Computers & Graphics, 54*, 1–14. https://doi.org/10.1016/j.cag.2015.10.014

Thayer, A., Lee, C. P., Hwang, L. H., Sales, H., Sen, P., & Dalal, N. (2011). The imposition and superimposition of digital reading technology: The academic potential of e-readers. In *Proceedings of CHI ’11* (pp. 2917–2926). https://doi.org/10.1145/1978942.1979375

Wang, B., Xu, C., Zhao, X., Ouyang, L., Wu, F., Zhao, Z., et al. (2024). *MinerU: An Open-Source Solution for Precise Document Content Extraction*. arXiv:2409.18839. https://doi.org/10.48550/arXiv.2409.18839

Wang, L. L., Cachola, I., Bragg, J., Latzke, M., Wagner, L., Head, A., & Weld, D. S. (2021). SciA11y: Converting scientific papers to accessible HTML. In *Proceedings of ASSETS ’21*. https://doi.org/10.1145/3441852.3476545

World Wide Web Consortium. (2017). *Web Annotation Data Model*. https://www.w3.org/TR/annotation-model/

World Wide Web Consortium. (2023). *EPUB 3.3*. https://www.w3.org/TR/epub-33/

World Wide Web Consortium. (2026). *EPUB Annotations 1.0: Working Draft*. https://www.w3.org/TR/epub-annotations-1.0/

World Wide Web Consortium. (2018). *CSS Fragmentation Module Level 3* (W3C Candidate Recommendation, 4 December 2018). https://www.w3.org/TR/css-break-3/

Zhong, X., Tang, J., & Jimeno Yepes, A. (2019). PubLayNet: Largest dataset ever for document layout analysis. In *2019 International Conference on Document Analysis and Recognition* (pp. 1015–1022). https://doi.org/10.1109/ICDAR.2019.00166

---

## Appendix A. One-paragraph handoff

The literature establishes that adaptive document layout, PDF-to-EPUB conversion, scientific-paper reflow, semantic reconstruction, e-reader studies, and annotation repositioning are all prior art. Build the POC around their **integration**, not their rediscovery. Start from a trusted JATS-like article graph; generate A4, large e-ink, small e-ink, and continuous renditions; preserve IDs, provenance, reading anchors, and text annotations; use hybrid fallbacks for complex objects; expose layout decisions; then compare fixed PDF, geometric reflow, and semantic recomposition across contrasting geometries. Treat PDF ingestion and arbitrary freehand ink as later adapters/extensions. The publication claim should remain “to our knowledge” until a formal systematic search is completed.
