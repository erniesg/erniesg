import { describe, expect, it } from 'vitest'
import type { PdfPageAnalysis, PdfSourceRun } from './import-types'
import { reconstructPageAnalyses } from './pdf-layout'

function run(
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10,
): PdfSourceRun {
  return {
    page: 1,
    text,
    x,
    y,
    width,
    height: 0.018,
    rotation: 0,
    method: 'pdf-text',
    fontName: fontSize > 12 ? 'Heading' : 'Body',
    fontSize,
    confidence: 1,
  }
}

function page(runs: PdfSourceRun[]): PdfPageAnalysis {
  return {
    page: 1,
    kind: 'born-digital',
    width: 612,
    height: 792,
    rotation: 0,
    textCharacters: runs.reduce((total, item) => total + item.text.length, 0),
    imageCount: 0,
    runs,
  }
}

function reconstruct(runs: PdfSourceRun[], metadata = {}) {
  return reconstructPageAnalyses({
    pages: [page(runs)],
    sourceHash: 'f'.repeat(64),
    fileName: 'front-matter-regression.pdf',
    byteLength: 4096,
    metadata,
  })
}

describe('PDF front-matter reconstruction', () => {
  it('keeps an embedded ACM reference block separate from the keyword values', async () => {
    const result = await reconstruct([
      run('A Source-Backed Paper', 0.2, 0.08, 0.6, 18),
      run('Ada Example', 0.42, 0.14, 0.16, 11),
      run('Abstract', 0.1, 0.22, 0.14, 12),
      run('The source abstract remains canonical.', 0.1, 0.25, 0.72),
      run('KEYWORDS', 0.1, 0.31, 0.14, 12),
      run('Multilingual; Fact-checking', 0.1, 0.34, 0.25, 9),
      run('ACM Reference Format:', 0.1, 0.365, 0.22, 8),
      run('Ada Example. 2026. A Source-Backed Paper.', 0.1, 0.39, 0.7, 8),
      run('1 Introduction', 0.1, 0.46, 0.28, 13),
      run('Canonical introduction prose.', 0.1, 0.5, 0.72),
    ])

    const paragraphs = result.paper.nodes
      .filter((node) => node.type === 'paragraph')
      .map((node) => node.text)
    expect(paragraphs).toContain('Multilingual; Fact-checking')
    expect(paragraphs).toContain(
      'ACM Reference Format: Ada Example. 2026. A Source-Backed Paper.',
    )
    expect(paragraphs).not.toContain(
      'Multilingual; Fact-checking ACM Reference Format: Ada Example. 2026. A Source-Backed Paper.',
    )
  })

  it('keeps acronym-bearing titles and recovers authors from mixed author-affiliation regions', async () => {
    const result = await reconstruct([
      run('MedAgentBench: A Realistic Virtual EHR', 0.24, 0.1, 0.52, 17),
      run('Environment to Benchmark Medical LLM Agents', 0.2, 0.125, 0.6, 17),
      run('Yixing Jiang', 0.27, 0.21, 0.09),
      run('∗', 0.36, 0.207, 0.008, 7),
      run('Kameron C. Black', 0.38, 0.21, 0.13),
      run('∗', 0.51, 0.207, 0.008, 7),
      run('Gloria Geng', 0.53, 0.21, 0.09),
      run('Danny Park', 0.64, 0.21, 0.08),
      run('James Zou', 0.33, 0.235, 0.08),
      run('Andrew Y. Ng', 0.43, 0.235, 0.1),
      run('Jonathan H. Chen', 0.55, 0.235, 0.13),
      run('Stanford University', 0.44, 0.26, 0.13),
      run('{jiang6,ang}@cs.stanford.edu', 0.38, 0.285, 0.24),
      run('Abstract', 0.46, 0.33, 0.08, 12),
      run('The source abstract remains canonical.', 0.23, 0.37, 0.54),
    ])

    expect(result.paper).toMatchObject({
      title:
        'MedAgentBench: A Realistic Virtual EHR Environment to Benchmark Medical LLM Agents',
      authors: [
        'Yixing Jiang',
        'Kameron C. Black',
        'Gloria Geng',
        'Danny Park',
        'James Zou',
        'Andrew Y. Ng',
        'Jonathan H. Chen',
      ],
      affiliations: expect.arrayContaining(['Stanford University']),
      abstract: 'The source abstract remains canonical.',
    })
  })

  it('recovers an author whose name wraps across centered title-page lines', async () => {
    const result = await reconstruct([
      run('Risk Management for Distributed Systems', 0.2, 0.08, 0.6, 18),
      run(
        'Akaash Vishal Hazarika1*, Mahak Shah2, Swapnil Patil3, Pradyumna',
        0.16,
        0.14,
        0.68,
        11,
      ),
      run('Shukla3', 0.44, 0.162, 0.12, 11),
      run('1 North Carolina State University', 0.28, 0.2, 0.44, 9),
      run('2 Columbia University', 0.34, 0.222, 0.32, 9),
      run('3 IEEE Senior Member', 0.36, 0.244, 0.28, 9),
      run('Abstract', 0.44, 0.3, 0.12, 12),
      run('The source abstract remains canonical.', 0.2, 0.34, 0.6),
    ])

    expect(result.paper.authors).toEqual([
      'Akaash Vishal Hazarika',
      'Mahak Shah',
      'Swapnil Patil',
      'Pradyumna Shukla',
    ])
  })

  it('does not select an oversized affiliation as the publication title', async () => {
    const result = await reconstruct([
      run('Stanford University', 0.32, 0.07, 0.36, 20),
      run('Actual Scholarly Paper Title', 0.2, 0.12, 0.6, 17),
      run('Ada Lovelace; Ben Reader', 0.3, 0.18, 0.4),
      run('Abstract', 0.45, 0.26, 0.1, 12),
      run('The source abstract remains canonical.', 0.23, 0.3, 0.54),
    ])

    expect(result.paper).toMatchObject({
      title: 'Actual Scholarly Paper Title',
      authors: ['Ada Lovelace', 'Ben Reader'],
      affiliations: expect.arrayContaining(['Stanford University']),
    })
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'UNRESOLVED_FRONT_MATTER',
    )
  })

  it('keeps an all-caps title continuation while excluding nearby affiliations', async () => {
    const result = await reconstruct(
      [
        run(
          'PERSONA VECTORS: MONITORING AND CONTROLLING',
          0.18,
          0.09,
          0.64,
          17,
        ),
        run('CHARACTER TRAITS IN LANGUAGE MODELS', 0.18, 0.12, 0.53, 14),
        run('Runjin Chen*1 Andy Arditi†1 Henry Sleight3', 0.19, 0.165, 0.48),
        run('1 Anthropic Fellows Program 2UT Austin', 0.19, 0.19, 0.3),
        run('3 Constellation 4Truthful AI', 0.19, 0.215, 0.27),
        run('ABSTRACT', 0.45, 0.27, 0.1, 12),
        run('The abstract is bounded source prose.', 0.23, 0.31, 0.54),
      ],
      {
        author: 'Runjin Chen; Andy Arditi; Henry Sleight',
      },
    )

    expect(result.paper.title).toBe(
      'PERSONA VECTORS: MONITORING AND CONTROLLING CHARACTER TRAITS IN LANGUAGE MODELS',
    )
    expect(result.paper.title).not.toContain('Anthropic Fellows Program')
    expect(result.paper.title).not.toContain('Constellation')
    expect(result.paper.affiliations).toEqual(
      expect.arrayContaining(['1 Anthropic Fellows Program 2UT Austin']),
    )
  })

  it('keeps visible title punctuation and a same-style marked collective byline', async () => {
    const result = await reconstruct(
      [
        run(
          'Toward Black–Scholes for Prediction Markets: A Unified Kernel and',
          0.19,
          0.12,
          0.62,
          21,
        ),
        run('Market-Maker’s Handbook', 0.27, 0.15, 0.46, 21),
        run('Shaw Dalen∗', 0.44, 0.245, 0.14, 14),
        run('Daedalus Research Team†', 0.4, 0.28, 0.22, 14),
        run('Abstract', 0.46, 0.34, 0.08, 12),
        run('Prediction-market abstract text.', 0.23, 0.38, 0.54),
      ],
      {
        title:
          "Toward Black Scholes for Prediction Markets: A Unified Kernel and Market Maker's Handbook",
        author: 'Shaw Dalen',
      },
    )

    expect(result.paper.title).toBe(
      'Toward Black–Scholes for Prediction Markets: A Unified Kernel and Market-Maker’s Handbook',
    )
    expect(result.paper.authors).toEqual([
      'Shaw Dalen',
      'Daedalus Research Team',
    ])
    expect(result.paper.affiliations ?? []).not.toContain(
      'Daedalus Research Team†',
    )
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_FRONT_MATTER',
    )
  })

  it('keeps a smaller research-group affiliation out of the collective byline', async () => {
    const result = await reconstruct([
      run('A Source-Backed Paper', 0.2, 0.1, 0.6, 18),
      run('Ada Example∗', 0.42, 0.18, 0.16, 14),
      run('Example Research Team†', 0.38, 0.22, 0.24, 9),
      run('Abstract', 0.46, 0.31, 0.08, 12),
      run('Source abstract text.', 0.23, 0.35, 0.54),
    ])

    expect(result.paper.authors).toEqual(['Ada Example'])
    expect(result.paper.affiliations).toContain('Example Research Team†')
  })

  it('uses exact visible multi-block metadata corroboration for a Title-Case continuation', async () => {
    const title =
      'Scaling up Test-Time Compute with Latent Reasoning: A Recurrent Depth Approach'
    const result = await reconstruct(
      [
        run(
          'Scaling up Test-Time Compute with Latent Reasoning:',
          0.21,
          0.1,
          0.55,
          14,
        ),
        run('A Recurrent Depth Approach', 0.34, 0.13, 0.3, 14),
        run('Jonas Geiping 1 Sean McLeish 2', 0.18, 0.2, 0.62),
        run('Abstract', 0.24, 0.26, 0.1, 12),
        run('The source abstract remains canonical.', 0.12, 0.3, 0.34),
      ],
      { title },
    )

    expect(result.paper.title).toBe(title)
    expect(
      result.paper.nodes.filter(
        (node) => 'text' in node && node.text === 'A Recurrent Depth Approach',
      ),
    ).toEqual([])
  })

  it('detects an exact split metadata title without an abstract boundary', async () => {
    const title = 'A Split Metadata Title'
    const result = await reconstruct(
      [
        run('A Split', 0.28, 0.08, 0.44, 16),
        run('Metadata Title', 0.24, 0.11, 0.52, 16),
        run('1 Introduction', 0.12, 0.24, 0.3, 13),
        run('Canonical introduction prose.', 0.12, 0.29, 0.76),
      ],
      { title },
    )

    expect(result.paper.title).toBe(title)
    expect(
      result.paper.nodes.find(
        (node) => node.type === 'heading' && node.text === '1 Introduction',
      ),
    ).toMatchObject({ type: 'heading', level: 1 })
    expect(result.paper.affiliations ?? []).not.toContain('1 Introduction')
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_FRONT_MATTER',
    )
  })

  it('preserves an unlabelled abstract candidate instead of absorbing it into affiliations', async () => {
    const abstract =
      'Multimodal machine learning is a vibrant multi-disciplinary research field that studies intelligent systems using linguistic, acoustic, visual, tactile, and physiological messages. Although a University-hosted research community contributes many applications, the breadth of progress makes common themes difficult to identify. This survey therefore synthesizes historical and recent perspectives and identifies open questions for future research.'
    const result = await reconstruct(
      [
        run(
          'Foundations and Trends in Multimodal Machine Learning',
          0.18,
          0.08,
          0.64,
          18,
        ),
        run('PAUL READER, AMIR WRITER, and LOUIS AUTHOR', 0.18, 0.14, 0.64),
        run(
          'Machine Learning Department, Example University, USA',
          0.18,
          0.18,
          0.64,
          9,
        ),
        run(abstract, 0.18, 0.23, 0.64, 9),
        run(
          'CCS Concepts: Computing methodologies → Machine learning',
          0.18,
          0.36,
          0.64,
          9,
        ),
        run(
          'Additional Key Words and Phrases: multimodal learning',
          0.18,
          0.4,
          0.64,
          9,
        ),
        run('1 INTRODUCTION', 0.18, 0.47, 0.3, 13),
        run('Canonical introduction prose.', 0.18, 0.52, 0.64, 9),
      ],
      {
        title: 'Foundations and Trends in Multimodal Machine Learning',
      },
    )

    expect(result.paper.abstract).toBe(abstract.slice(0, 700))
    expect(
      result.paper.nodes.find(
        (node) => node.type === 'paragraph' && node.text === abstract,
      ),
    ).toBeDefined()
    expect(result.paper.affiliations ?? []).not.toContain(abstract)
    expect(result.readiness.blockingDiagnosticCodes).toContain(
      'UNRESOLVED_FRONT_MATTER',
    )
  })

  it('splits a compact affiliation line from an attached unlabelled abstract', async () => {
    const abstractLines = [
      'Multimodal learning studies intelligent systems that integrate linguistic, acoustic, visual, tactile, and physiological messages.',
      'Recent progress spans video understanding, embodied agents, generation, healthcare, robotics, and multisensor fusion, creating shared computational and theoretical challenges.',
      'This survey synthesizes historical and recent perspectives, proposes a technical taxonomy, and identifies open questions for future research.',
    ]
    const abstract = abstractLines.join(' ')
    const result = await reconstruct(
      [
        run('A Source-Backed Survey', 0.18, 0.08, 0.64, 18),
        run('PAUL READER, AMIR WRITER, and LOUIS AUTHOR', 0.18, 0.14, 0.64),
        run(
          'Machine Learning Department, Example University, USA',
          0.18,
          0.18,
          0.64,
          9,
        ),
        ...abstractLines.map((text, index) =>
          run(text, 0.18, 0.198 + index * 0.018, 0.64, 9),
        ),
        run(
          'CCS Concepts: Computing methodologies → Machine learning',
          0.18,
          0.31,
          0.64,
          9,
        ),
        run('1 INTRODUCTION', 0.18, 0.4, 0.3, 13),
        run('Canonical introduction prose.', 0.18, 0.45, 0.64, 9),
      ],
      { title: 'A Source-Backed Survey' },
    )

    expect(result.paper.abstract).toBe(abstract)
    expect(
      result.paper.nodes.find(
        (node) => node.type === 'paragraph' && node.text === abstract,
      ),
    ).toBeDefined()
    expect(result.paper.affiliations).toEqual(
      expect.arrayContaining([
        'Machine Learning Department, Example University, USA',
      ]),
    )
    expect(result.paper.affiliations ?? []).not.toEqual(
      expect.arrayContaining([expect.stringContaining('Multimodal learning')]),
    )
  })

  it('stops author recovery at the first affiliation inside a mixed metadata region', async () => {
    const title = 'Foundations in Multimodal Machine Learning'
    const result = await reconstruct(
      [
        run(title, 0.18, 0.08, 0.64, 18),
        run(
          'PAUL PU LIANG, AMIR ZADEH, and LOUIS-PHILIPPE MORENCY',
          0.18,
          0.14,
          0.64,
        ),
        run(
          'Machine Learning Department, Example University',
          0.18,
          0.16,
          0.64,
          9,
        ),
        run(
          'This survey discusses models from a University-hosted research community.',
          0.18,
          0.18,
          0.64,
          9,
        ),
        run('Additional Key Words and Phrases', 0.18, 0.2, 0.64, 9),
        run(
          'Paul Pu Liang, Amir Zadeh, and Louis-Philippe Morency. 2022.',
          0.18,
          0.22,
          0.64,
          9,
        ),
      ],
      { title },
    )

    expect(result.paper.authors).toEqual([
      'PAUL PU LIANG',
      'AMIR ZADEH',
      'LOUIS-PHILIPPE MORENCY',
    ])
  })

  it('retains the final author after an authored conjunction', async () => {
    const abstract =
      'Source abstract prose with a project page: https://example.org/paper'
    const result = await reconstruct([
      run('BookWorld: A Source Paper', 0.18, 0.08, 0.64, 18),
      run(
        'Yiting Ran*1, Xintao Wang*1, Tian Qiu1, Jiaqing Liang1, Yanghua Xiao1 and Deqing Yang1',
        0.12,
        0.15,
        0.76,
      ),
      run('* Equal contributions, 1 Fudan University', 0.25, 0.19, 0.5, 9),
      run(`Abstract: ${abstract}`, 0.12, 0.27, 0.76),
    ])

    expect(result.paper.authors).toEqual([
      'Yiting Ran',
      'Xintao Wang',
      'Tian Qiu',
      'Jiaqing Liang',
      'Yanghua Xiao',
      'Deqing Yang',
    ])
    expect(result.paper.abstract).toBe(abstract)
    expect(result.paper.affiliations).not.toEqual(
      expect.arrayContaining([expect.stringContaining('project page')]),
    )
  })

  it('does not absorb adjacent-column body prose into the abstract', async () => {
    const result = await reconstruct([
      run('Two-column front matter', 0.18, 0.08, 0.64, 18),
      run('Ada Example; Ben Reader', 0.31, 0.15, 0.38),
      run('Example University', 0.36, 0.19, 0.28),
      run('Abstract', 0.24, 0.26, 0.1, 12),
      run('Left-column abstract sentence.', 0.12, 0.3, 0.34),
      run('Right-column introduction prose.', 0.54, 0.3, 0.34),
      run('Left abstract conclusion.', 0.12, 0.325, 0.34),
      run('Right body continuation.', 0.54, 0.325, 0.34),
    ])

    expect(result.paper.abstract).toBe(
      'Left-column abstract sentence. Left abstract conclusion.',
    )
    expect(result.paper.abstract).not.toContain('Right-column')
  })

  it('fails publication readiness closed when title or author roles remain unresolved', async () => {
    const result = await reconstruct([
      run('Abstract', 0.45, 0.16, 0.1, 12),
      run('Only source body prose is recoverable.', 0.16, 0.22, 0.68),
    ])

    expect(result.readiness.ready).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_FRONT_MATTER',
          severity: 'error',
          page: 1,
        }),
      ]),
    )
  })

  it('keeps the visible byline when PDF author metadata conflicts and fails readiness closed', async () => {
    const result = await reconstruct(
      [
        run('Visible Byline Authority', 0.2, 0.08, 0.6, 18),
        run('Ada Example; Ben Reader', 0.31, 0.15, 0.38),
        run('Abstract', 0.45, 0.24, 0.1, 12),
        run('The source abstract remains canonical.', 0.16, 0.29, 0.68),
      ],
      { author: 'Unrelated Metadata Person' },
    )

    expect(result.paper.authors).toEqual(['Ada Example', 'Ben Reader'])
    expect(result.paper.authors).not.toContain('Unrelated Metadata Person')
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNRESOLVED_FRONT_MATTER',
          severity: 'error',
          message: expect.stringMatching(/author metadata.*conflict/i),
        }),
      ]),
    )
  })

  it('allows normalized PDF author metadata only when the visible byline corroborates it', async () => {
    const result = await reconstruct(
      [
        run('Corroborated Visible Byline', 0.2, 0.08, 0.6, 18),
        run('Ada Example1; Ben Reader2', 0.31, 0.15, 0.38),
        run('1 Example University 2 Reader Institute', 0.25, 0.19, 0.5, 9),
        run('Abstract', 0.45, 0.25, 0.1, 12),
        run('The source abstract remains canonical.', 0.16, 0.3, 0.68),
      ],
      { author: 'Ada Example, Ben Reader' },
    )

    expect(result.paper.authors).toEqual(['Ada Example', 'Ben Reader'])
    expect(result.readiness.blockingDiagnosticCodes).not.toContain(
      'UNRESOLVED_FRONT_MATTER',
    )
  })

  it('keeps metadata-only authors as reviewable fallback data and proves they are unprovenanced even with a canonical title node', async () => {
    const result = await reconstruct(
      [
        run('Canonical Metadata Blind Spot', 0.18, 0.08, 0.64, 18),
        run('1 Introduction', 0.12, 0.2, 0.3, 16),
        run('Canonical body prose follows.', 0.12, 0.26, 0.7),
      ],
      { author: 'Metadata Only Author' },
    )

    expect(result.paper.authors).toEqual(['Metadata Only Author'])
    expect(result.readiness.blockingDiagnosticCodes).toEqual(
      expect.arrayContaining([
        'UNRESOLVED_FRONT_MATTER',
        'UNPROVENANCED_RENDERED_UNIT',
      ]),
    )
  })

  it.each(['Microsoft Word', 'Microsoft Word - creator', 'Creator'])(
    'rejects placeholder PDF author metadata %j as a canonical byline',
    async (author) => {
      const result = await reconstruct(
        [
          run('Placeholder Metadata', 0.2, 0.08, 0.6, 18),
          run('Abstract', 0.45, 0.2, 0.1, 12),
          run('The source abstract remains canonical.', 0.16, 0.25, 0.68),
        ],
        { author },
      )

      expect(result.paper.authors).toEqual(['Imported locally'])
      expect(result.paper.authors).not.toContain(author)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'UNRESOLVED_FRONT_MATTER',
            severity: 'error',
            message: expect.stringMatching(/placeholder author metadata/i),
          }),
        ]),
      )
    },
  )

  it('splits a compact multi-affiliation footer into exact author targets and a separate correspondence note', async () => {
    const raisedMarker = (text: string, x: number, y: number) => ({
      ...run(text, x, y - 0.001, 0.008, 6),
      height: 0.009,
    })
    const result = await reconstruct(
      [
        run('A Multi-Institution Source Paper', 0.2, 0.08, 0.6, 18),
        run('Ada Example', 0.12, 0.15, 0.13, 11),
        raisedMarker('1', 0.251, 0.15),
        run('Ben Reader', 0.28, 0.15, 0.12, 11),
        raisedMarker('2', 0.401, 0.15),
        run('Cara Scholar', 0.43, 0.15, 0.13, 11),
        raisedMarker('2', 0.561, 0.15),
        run('Dan Researcher', 0.59, 0.15, 0.15, 11),
        raisedMarker('3', 0.741, 0.15),
        run('Abstract', 0.1, 0.27, 0.16, 12),
        run('The source abstract remains canonical.', 0.1, 0.31, 0.72),
        run('1 Introduction', 0.1, 0.42, 0.3, 13),
        run('Canonical introduction prose.', 0.1, 0.47, 0.72),
        run(
          'A second body line establishes the ordinary prose size.',
          0.1,
          0.5,
          0.72,
        ),
        run(
          'A third body line keeps the lower-band boundary honest.',
          0.1,
          0.53,
          0.72,
        ),
        run(
          'A fourth body line mentions Intelligent systems in ordinary prose.',
          0.1,
          0.56,
          0.72,
        ),
        run(
          'A fifth body line mentions a College campus in ordinary prose.',
          0.1,
          0.59,
          0.72,
        ),
        run(
          'A sixth body line remains ordinary canonical prose.',
          0.1,
          0.62,
          0.72,
        ),
        run(
          'A seventh body line remains ordinary canonical prose.',
          0.1,
          0.65,
          0.72,
        ),
        run(
          'An eighth body line remains ordinary canonical prose.',
          0.1,
          0.68,
          0.72,
        ),
        run(
          'A ninth body line remains ordinary canonical prose.',
          0.1,
          0.71,
          0.72,
        ),
        raisedMarker('1', 0.1, 0.82),
        run(
          'ELLIS Institute Tübingen, Max-Planck Institute for Intelli-',
          0.11,
          0.82,
          0.5,
          8,
        ),
        run('gent Systems, Tübingen AI Center', 0.1, 0.84, 0.29, 8),
        raisedMarker('2', 0.395, 0.84),
        run('University of Maryland, Col-', 0.405, 0.84, 0.26, 8),
        run('lege Park', 0.1, 0.86, 0.08, 8),
        raisedMarker('3', 0.185, 0.86),
        run(
          'Lawrence Livermore National Laboratory. Correspon-',
          0.195,
          0.86,
          0.47,
          8,
        ),
        run(
          'dence to: Ada Example, Dan Researcher <ada@example.edu,',
          0.1,
          0.88,
          0.52,
          8,
        ),
        run('dan@example.gov>.', 0.1, 0.9, 0.16, 8),
      ],
      { language: 'en-US' },
    )

    const notes = result.paper.nodes.filter((node) => node.type === 'footnote')
    const affiliationNotes = notes.filter((node) =>
      ['1', '2', '3'].includes(node.label),
    )
    const correspondence = notes.find((node) => node.label === 'Correspondence')
    const authorNotes = result.paper.authorNotes ?? []
    expect(
      affiliationNotes.map(({ label, text }) => ({ label, text })),
    ).toEqual([
      {
        label: '1',
        text: 'ELLIS Institute Tübingen, Max-Planck Institute for Intelligent Systems, Tübingen AI Center',
      },
      {
        label: '2',
        text: 'University of Maryland, College Park',
      },
      {
        label: '3',
        text: 'Lawrence Livermore National Laboratory.',
      },
    ])
    expect(authorNotes.map(({ author, label }) => ({ author, label }))).toEqual(
      [
        { author: 'Ada Example', label: '1' },
        { author: 'Ben Reader', label: '2' },
        { author: 'Cara Scholar', label: '2' },
        { author: 'Dan Researcher', label: '3' },
      ],
    )
    expect(
      affiliationNotes.map((note) => ({
        label: note.label,
        backlinks: note.relationships.backlinks,
      })),
    ).toEqual([
      {
        label: '1',
        backlinks: [authorNotes[0]?.id],
      },
      {
        label: '2',
        backlinks: [authorNotes[1]?.id, authorNotes[2]?.id],
      },
      {
        label: '3',
        backlinks: [authorNotes[3]?.id],
      },
    ])
    expect(correspondence).toMatchObject({
      type: 'footnote',
      kind: 'footnote',
      label: 'Correspondence',
      text: 'Ada Example, Dan Researcher <ada@example.edu, dan@example.gov>.',
      relationships: { backlinks: [] },
    })
    expect(notes.map((node) => node.text).join(' ')).not.toMatch(
      /[23](?:University|Lawrence)/u,
    )
    expect(result.noteRelationships).toHaveLength(4)
    expect(
      result.noteRelationships.every(
        (relationship) =>
          relationship.status === 'matched' &&
          relationship.canonicalAnchor?.kind === 'author',
      ),
    ).toBe(true)
  })

  it('keeps a shared title-page affiliation footnote author-owned and out of body flow', async () => {
    const raisedMarker = (text: string, x: number, y: number) => ({
      ...run(text, x, y - 0.001, 0.008, 6),
      height: 0.009,
    })
    const result = await reconstruct([
      run('Canonical Affiliation Placement', 0.2, 0.08, 0.6, 18),
      run('Ada Example', 0.3, 0.15, 0.13, 11),
      raisedMarker('1', 0.431, 0.15),
      run('Ben Reader', 0.47, 0.15, 0.12, 11),
      raisedMarker('1', 0.591, 0.15),
      run('Abstract', 0.1, 0.27, 0.16, 12),
      run('The source abstract remains canonical.', 0.1, 0.31, 0.72),
      run('1 Introduction', 0.1, 0.42, 0.3, 13),
      run('Canonical introduction prose remains first.', 0.1, 0.47, 0.72),
      run('A second ordinary body line proves the prose size.', 0.1, 0.5, 0.72),
      run('A third ordinary body line remains canonical.', 0.1, 0.53, 0.72),
      run('A fourth ordinary body line remains canonical.', 0.1, 0.56, 0.72),
      run('A fifth ordinary body line remains canonical.', 0.1, 0.59, 0.72),
      run('A sixth ordinary body line remains canonical.', 0.1, 0.62, 0.72),
      run('A seventh ordinary body line remains canonical.', 0.1, 0.65, 0.72),
      run('An eighth ordinary body line remains canonical.', 0.1, 0.68, 0.72),
      run('A ninth ordinary body line remains canonical.', 0.1, 0.71, 0.72),
      raisedMarker('1', 0.1, 0.82),
      run(
        'Example Institute of Technology. Correspondence to:',
        0.11,
        0.82,
        0.5,
        8,
      ),
      run('Ada Example <ada@example.edu>.', 0.1, 0.84, 0.29, 8),
    ])

    const note = result.paper.nodes.find(
      (node) => node.type === 'footnote' && node.label === '1',
    )
    const pageOneRelationships = result.noteRelationships.filter(
      (relationship) => relationship.sourceBoxes[0]?.page === 1,
    )
    expect(note).toMatchObject({
      type: 'footnote',
      kind: 'footnote',
      label: '1',
      text: 'Example Institute of Technology. Correspondence to: Ada Example <ada@example.edu>.',
    })
    expect(result.paper.nodes[0]?.id).toBe(note?.id)
    expect(
      result.paper.authorNotes?.map(({ author, label, target }) => ({
        author,
        label,
        target,
      })),
    ).toEqual([
      { author: 'Ada Example', label: '1', target: note?.id },
      { author: 'Ben Reader', label: '1', target: note?.id },
    ])
    expect(
      pageOneRelationships.map((relationship) => ({
        status: relationship.status,
        owner: relationship.canonicalAnchor,
      })),
    ).toEqual([
      { status: 'matched', owner: { kind: 'author', author: 'Ada Example' } },
      { status: 'matched', owner: { kind: 'author', author: 'Ben Reader' } },
    ])
    expect(
      result.diagnostics
        .flatMap((diagnostic) =>
          diagnostic.noteMarkerClassification
            ? [diagnostic.noteMarkerClassification]
            : [],
        )
        .filter(
          (classification) =>
            classification.referenceRegionId ===
            pageOneRelationships[0]?.referenceRegionId,
        )
        .map(({ taxonomy, disposition, accepted }) => ({
          taxonomy,
          disposition,
          accepted,
        })),
    ).toEqual([
      {
        taxonomy: 'footnote-reference',
        disposition: 'note-reference',
        accepted: true,
      },
      {
        taxonomy: 'footnote-reference',
        disposition: 'note-reference',
        accepted: true,
      },
    ])
    expect(
      result.paper.nodes
        .filter((node) => node.type === 'paragraph')
        .map((node) => node.text)
        .join(' '),
    ).not.toContain('Example Institute of Technology')
  })

  it('preserves a title-page contact line separately from its numbered affiliations', async () => {
    const raisedMarker = (text: string, x: number, y: number) => ({
      ...run(text, x, y - 0.001, 0.008, 6),
      height: 0.009,
    })
    const result = await reconstruct([
      run('Contact-complete source paper', 0.2, 0.07, 0.6, 18),
      run('Ada Example', 0.2, 0.13, 0.13, 11),
      raisedMarker('1', 0.331, 0.13),
      run('Ben Reader', 0.38, 0.13, 0.12, 11),
      raisedMarker('2', 0.501, 0.13),
      raisedMarker('1', 0.367, 0.18),
      run('XY Campus,', 0.375, 0.18, 0.108, 10),
      raisedMarker('2', 0.489, 0.18),
      run('ZQ AI,', 0.497, 0.18, 0.072, 10),
      raisedMarker('3', 0.574, 0.18),
      run('ABC', 0.582, 0.18, 0.055, 10),
      run('{ada,ben}@example.edu,reader@example.org', 0.166, 0.205, 0.672, 9),
      run('Abstract', 0.1, 0.28, 0.16, 12),
      run('The source abstract remains canonical.', 0.1, 0.32, 0.72),
      run('1 Introduction', 0.1, 0.42, 0.3, 13),
      run('Canonical introduction prose.', 0.1, 0.47, 0.72),
    ])

    expect(result.paper.affiliations).toEqual([
      '1 XY Campus,',
      '2 ZQ AI,',
      '3 ABC',
    ])
    expect(result.paper.authorAffiliations).toEqual([
      { author: 'Ada Example', label: '1' },
      { author: 'Ben Reader', label: '2' },
    ])
    expect(
      result.paper.nodes.find(
        (node) => node.type === 'footnote' && node.label === 'Correspondence',
      ),
    ).toMatchObject({
      type: 'footnote',
      kind: 'footnote',
      label: 'Correspondence',
      text: '{ada,ben}@example.edu,reader@example.org',
      relationships: { backlinks: [] },
    })
    expect(result.completeness.missingSourceRegionCount).toBe(0)
    expect(result.completeness.unprovenancedRenderedUnitCount).toBe(0)
    const correspondence = result.paper.nodes.find(
      (node) => node.type === 'footnote' && node.label === 'Correspondence',
    )
    expect(result.provenance[correspondence!.id].regionIds).toEqual([
      expect.not.stringContaining('contact-evidence'),
    ])
  })
})
