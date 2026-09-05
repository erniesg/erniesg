# docling-struct: PDF → StructDocument → EPUB through `@erniesg/struct`

The app-owned extraction adapter for scholarly PDFs. It follows the ownership
split in ADR-0001: **this directory extracts and adapts; `erniesg/struct`
renders.** Nothing here writes XHTML or packages an EPUB.

```
PDF ──Docling (local layout model)──▶ DoclingDocument
    ──pdf2struct.py──▶ StructDocument draft (blocks, assets, relationships, pages, diagnostics)
    ──render.mjs (@erniesg/struct: seal receipt, strict codec, XHTML, EPUB per profile)──▶ .epub
    ──evaluate.py (source-derived reader criteria)──▶ report in the corpus-audit document shape
    ──tools/pdf-success-scorecard.mjs──▶ per-criterion, per-stratum scorecard
```

## What the adapter maps

| Docling element | STRUCT | Notes |
| --- | --- | --- |
| title / first page-1 heading | `metadata.title` | rendered by struct as the publication header |
| section_header | `heading` + `attributes.level` | level from numbering (`3.1` → h3), known names (`References`) → h2, unnumbered after `3.1` → h4 |
| text | `paragraph` | joined across column/page breaks and across floats only when the previous paragraph lacks terminal punctuation and the next starts lowercase; trailing hyphens dropped only when the fused word occurs elsewhere in the paper |
| list_item (ListGroup) | `list-item` + `attributes.ordered/listId` | struct groups them into `<ol>`/`<ul>` |
| picture + caption | `figure` (text = caption) + `fallbackAssetIds` | caption-less pictures under 1% of the page are decorative and skipped; a caption-less figure adopts an adjacent orphan `Figure N` caption |
| table + caption | `table` (cell grid, header scopes, spans) + `caption` block + `caption` relationship | no grid → crop asset as a figure |
| formula | `equation` + `attributes.mathml` (LaTeX via latex2mathml) or crop asset | `--formula` turns on Docling's formula enrichment |
| footnote | `footnote` block + `note-reference` inline run + `footnote` relationship | marker found in same-page prose (`tokens. 9`, `story1`); affiliation-style weak matches link once |
| code | `code` | |
| page_header / page_footer, edge page numbers | `furniture` blocks with evidence | accounted, never rendered |
| PDF link annotations (pypdf) + word boxes (pdftotext) | inline runs with `href` | matched to Docling items by rectangle overlap, whitespace-insensitive URL match |

Chart tick labels that the layout model left outside a picture (three or more
number-only lines in a row) are dropped as figure content and reported.

## Usage

```bash
# once: Python 3.12 venv with Docling, and a built erniesg/struct checkout beside this repo
uv venv --python 3.12 ~/.venvs/docling && source ~/.venvs/docling/bin/activate
uv pip install docling latex2mathml pypdf
(cd ../struct && npm ci && npm run build)

# convert one or many PDFs (directories are scanned for *.pdf)
python tools/docling-struct/pdf2epub.py paper.pdf --out out/ --profiles paperPro,paperProMove
python tools/docling-struct/pdf2epub.py ~/Papers --out out/ --workers 4

# score a run on the nine reader criteria
node tools/pdf-success-scorecard.mjs out/corpus-report.json --strata strata.json --markdown
```

Outputs per PDF: `<stem>.docling.json`, `<stem>.struct-draft.json`, the sealed
`struct.json`, struct's `content.xhtml`, one EPUB per profile, and
`<stem>.report.json`. EPUBCheck runs when it is on `PATH`.

Requires `pdftotext` (poppler) for link word boxes and source text, and
`node` ≥ 22 for `render.mjs`. Source PDFs never leave the machine.

## Reader criteria measured by `evaluate.py`

Expectations come from the PDF, never from the adapter's output:

- figures: `Figure N` / `Fig. N` caption labels in the text layer vs `<figcaption>` labels in the EPUB
- tables: `Table N` labels vs `<table>` blocks (a crop counts as fallback, not structure)
- footnotes: footnote blocks vs matched note references (adapter count; documented limitation)
- links: URI annotations with visible text, outside running lines, vs `href`s in the EPUB (icon links excluded)
- furniture: lines repeated on three or more pages, and page-edge numbers, must not appear as paragraphs
- prose continuity: word coverage ≥ 0.98 (words inside detected figures excluded) and ≤ 2% lowercase-starting prose paragraphs outside the bibliography and after equations
- EPUBCheck errors

## Status

Pilot on five diverse papers (arXiv two-column, Springer, Nature Medicine,
OJS journal, scanned chapter): every one passes struct's strict codec and
EPUBCheck. Remaining measured gaps are figures the layout model misses,
tables typeset as text boxes, and a few unmatched note markers; see the
corpus scorecard for the numbers.
