/** Public research framing; results refer to the named evidence, not a release claim. */
export const structProject = {
  title: 'Struct: Portable Document Semantics and PDF Import',
  path: '/research/struct/',
  status: 'Supporting component',
  summary:
    'A supporting component for portable document semantics, rendering, and an experimental PDF-to-EPUB import demonstration.',
  question:
    'How can we reconstruct scholarly documents for different reading surfaces and verify what survives, what changes, and what still needs correction?',
  repository: 'https://github.com/erniesg/struct',
  demoPath: '/research/struct/demo/',
} as const

export type StructSample = {
  id: string
  title: string
  description: string
  pdfUrl: string
  htmlUrl?: string
  convertSampleId?: string
  epubUrls: { label: string; url: string }[]
  verdict?: string
  attribution?: {
    authors: string
    sourceUrl: string
    license: string
    licenseUrl: string
    changes: string
  }
}

/** Actual external works; attribution and source terms travel with each sample. */
export const structSamples: StructSample[] = [
  {
    id: 'attention-is-all-you-need',
    title: 'Attention Is All You Need',
    description:
      'The Transformer paper, with architecture diagrams, attention visualizations, equations, and comparison tables. Convert the original arXiv PDF using your daily allowance.',
    pdfUrl: 'https://arxiv.org/pdf/1706.03762v7',
    convertSampleId: 'attention-is-all-you-need',
    epubUrls: [],
    attribution: {
      authors:
        'Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Łukasz Kaiser, and Illia Polosukhin',
      sourceUrl: 'https://arxiv.org/abs/1706.03762v7',
      license: 'arXiv distribution terms',
      licenseUrl: 'https://arxiv.org/licenses/nonexclusive-distrib/1.0/',
      changes:
        'The original stays on arXiv. Conversion creates a private result for your network; no full copy or adaptation of this paper is mirrored in the public samples.',
    },
  },
  {
    id: 'docling-technical-report',
    title: 'Docling Technical Report',
    description:
      'An AI document-conversion paper with tables, diagrams, document images, and Python API examples. Compare its PDF with the reflowed rendition.',
    pdfUrl: '/research/struct/samples/docling-technical-report/source.pdf',
    htmlUrl: '/research/struct/samples/docling-technical-report/content.html',
    verdict:
      'Review required: the local check recorded 97.5% text coverage and four of five captioned figures. Tables and code still need comparison with the source.',
    attribution: {
      authors: 'Christoph Auer and coauthors',
      sourceUrl: 'https://arxiv.org/abs/2408.09869v5',
      license: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      changes:
        'Reconstructed and reflowed automatically with the Struct reference adapter. The authors do not endorse this demonstration.',
    },
    epubUrls: [
      {
        label: 'Paper Pro EPUB',
        url: '/research/struct/samples/docling-technical-report/paperpro.epub',
      },
      {
        label: 'Paper Pro Move EPUB',
        url: '/research/struct/samples/docling-technical-report/papermove.epub',
      },
    ],
  },
  {
    id: 'ai-must-die',
    title: 'AI Must Die',
    description:
      'A 32-page illustrated zine by Myke Walton and Cam Smith, used here to explore reflow across a less conventional layout.',
    pdfUrl: '/research/struct/samples/ai-must-die/source.pdf',
    htmlUrl: '/research/struct/samples/ai-must-die/content.html',
    verdict:
      'Review required: the automatic check found an unresolved source link. This sample is a demonstration, not a corpus benchmark.',
    attribution: {
      authors: 'Myke Walton and Cam Smith',
      sourceUrl: 'https://www.aimustdie.info/assets/AI_Must_Die_v1.4.4.pdf',
      license: 'CC BY-NC-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
      changes:
        'Reconstructed and reflowed automatically with the Struct reference adapter; the reading view and EPUBs are adaptations under the same license. Compare them with the original.',
    },
    epubUrls: [
      {
        label: 'Paper Pro EPUB',
        url: '/research/struct/samples/ai-must-die/paperpro.epub',
      },
      {
        label: 'Paper Pro Move EPUB',
        url: '/research/struct/samples/ai-must-die/papermove.epub',
      },
    ],
  },
]
