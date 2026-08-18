import { describe, expect, it } from 'vitest'
import {
  PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
  buildSourceEvidenceGraph,
  deterministicContextReceiptForBundle,
  readSourceEvidenceGraph,
  sourceEvidenceCandidateSetSha256,
  sourceEvidenceGraphSha256,
  validatePdfEvidenceBundle,
  validateSourceEvidenceGraph,
  type PdfEvidenceBox,
  type PdfEvidenceBundle,
  type PdfEvidenceProviderIdentity,
  type SourceEvidenceGraph,
  type SourceEvidenceGraphInput,
} from './source-evidence-graph'

const source = {
  documentId: 'fixture-paper',
  sha256: '1'.repeat(64),
  byteLength: 8_192,
  pageCount: 2,
} as const

function box(page: number, x: number): PdfEvidenceBox {
  return {
    page,
    x,
    y: 0.1,
    width: 0.2,
    height: 0.05,
    rotation: 0,
    method: 'pdf-text',
  }
}

function provider(
  id: string,
  kind: PdfEvidenceProviderIdentity['kind'],
): PdfEvidenceProviderIdentity {
  return {
    id,
    kind,
    name: kind === 'mineru' ? 'MinerU' : 'PDF.js',
    version: kind === 'mineru' ? '3.4.4' : '5.4.624',
    implementationSha256: (kind === 'mineru' ? 'a' : 'b').repeat(64),
    ...(kind === 'mineru'
      ? {
          model: {
            id: 'opendatalab/MinerU2.5-Pro-2605-1.2B',
            revision: 'bff20d4',
            digestSha256: 'c'.repeat(64),
            license: 'Apache-2.0',
            architecture: 'Qwen2VL',
          },
        }
      : {}),
  }
}

function bundle(
  id: string,
  armId: string,
  providerIdentity: PdfEvidenceProviderIdentity,
  candidateText: string,
): PdfEvidenceBundle {
  const sourceId = `${id}-source`
  const artifactId = `${id}-artifact`
  return {
    schemaVersion: PDF_EVIDENCE_BUNDLE_SCHEMA_VERSION,
    id,
    armId,
    source: { ...source },
    provider: providerIdentity,
    pages: [
      { page: 1, width: 612, height: 792, rotation: 0 },
      { page: 2, width: 612, height: 792, rotation: 0 },
    ],
    artifacts: [
      {
        id: artifactId,
        providerId: providerIdentity.id,
        kind: 'content-list-json',
        mediaType: 'application/json',
        sha256: (providerIdentity.kind === 'mineru' ? 'd' : 'e').repeat(64),
        byteLength: 64,
        page: 1,
        box: box(1, providerIdentity.kind === 'mineru' ? 0.11 : 0.1),
        sourceIds: [sourceId],
      },
    ],
    sources: [
      {
        id: sourceId,
        providerId: providerIdentity.id,
        kind: 'text-run',
        page: 1,
        box: box(1, providerIdentity.kind === 'mineru' ? 0.11 : 0.1),
        artifactIds: [artifactId],
        parentSourceIds: [],
        payload: { text: candidateText, tokens: ['grounded', 'source'] },
      },
    ],
    candidates: [
      {
        id: `${id}-candidate`,
        providerId: providerIdentity.id,
        kind: 'text',
        page: 1,
        boxes: [box(1, providerIdentity.kind === 'mineru' ? 0.11 : 0.1)],
        sourceIds: [sourceId],
        artifactIds: [artifactId],
        payload: { text: candidateText },
      },
    ],
  }
}

function input(): SourceEvidenceGraphInput {
  const pdfjs = bundle(
    'pdfjs-bundle',
    'deterministic',
    provider('pdfjs-provider', 'pdfjs'),
    'Grounded source text.',
  )
  const mineru = bundle(
    'mineru-bundle',
    'mineru',
    provider('mineru-provider', 'mineru'),
    'Grounded source text',
  )
  return {
    schemaVersion: SOURCE_EVIDENCE_GRAPH_SCHEMA_VERSION,
    source: { ...source },
    deterministicContext: deterministicContextReceiptForBundle(pdfjs),
    arms: [
      {
        id: 'deterministic',
        requirement: 'required',
        status: 'enabled',
        frozen: true,
        providerId: 'pdfjs-provider',
      },
      {
        id: 'mineru',
        requirement: 'required',
        status: 'enabled',
        frozen: true,
        providerId: 'mineru-provider',
      },
      {
        id: 'optional-ocr',
        requirement: 'optional',
        status: 'disabled',
        frozen: true,
        reason: 'disabled before the evidence run',
      },
    ],
    bundles: [pdfjs, mineru],
    obligations: [
      {
        id: 'body-text-obligation',
        kind: 'text',
        page: 1,
        sourceIds: ['pdfjs-bundle-source', 'mineru-bundle-source'],
        artifactIds: ['pdfjs-bundle-artifact', 'mineru-bundle-artifact'],
        candidateIds: ['pdfjs-bundle-candidate', 'mineru-bundle-candidate'],
        observationCategories: ['text-exactness'],
        required: true,
        semantic: true,
      },
    ],
    disagreements: [
      {
        id: 'terminal-punctuation-disagreement',
        kind: 'text',
        obligationIds: ['body-text-obligation'],
        candidateIds: ['pdfjs-bundle-candidate', 'mineru-bundle-candidate'],
        providerIds: ['pdfjs-provider', 'mineru-provider'],
        reason: 'Providers disagree about terminal punctuation.',
      },
    ],
  }
}

function cloneInput(value: SourceEvidenceGraphInput = input()) {
  return structuredClone(value)
}

describe('source evidence graph', () => {
  it('builds a provider-bound graph and exposes an immutable typed reader', () => {
    const mutableInput = input()
    const graph = buildSourceEvidenceGraph(mutableInput)
    const reader = readSourceEvidenceGraph(graph)

    expect(() => validateSourceEvidenceGraph(graph)).not.toThrow()
    expect(() => validatePdfEvidenceBundle(graph.bundles[0])).not.toThrow()
    expect(graph.graphSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(reader.source).toEqual(source)
    expect(reader.provider('mineru-provider')?.model).toMatchObject({
      revision: 'bff20d4',
      architecture: 'Qwen2VL',
    })
    expect(reader.sourceItem('pdfjs-bundle-source')?.kind).toBe('text-run')
    expect(reader.artifact('mineru-bundle-artifact')?.mediaType).toBe(
      'application/json',
    )
    expect(reader.candidate('pdfjs-bundle-candidate')?.sourceIds).toEqual([
      'pdfjs-bundle-source',
    ])
    expect(reader.page(1)).toHaveLength(2)
    expect(reader.candidatesForObligation('body-text-obligation')).toHaveLength(
      2,
    )
    expect(
      reader.disagreement('terminal-punctuation-disagreement'),
    ).not.toHaveProperty('acceptedCandidateId')
    expect(reader.graph).not.toHaveProperty('attempts')
    expect(reader.graph).not.toHaveProperty('comparator')
    expect(Object.isFrozen(reader)).toBe(true)
    expect(Object.isFrozen(reader.graph)).toBe(true)
    expect(Object.isFrozen(reader.graph.bundles[0]?.candidates[0])).toBe(true)
    expect(() => {
      reader.graph.bundles[0]!.candidates[0]!.kind = 'authored'
    }).toThrow()

    mutableInput.bundles[0]!.provider.name = 'mutated after build'
    expect(reader.provider('pdfjs-provider')?.name).toBe('PDF.js')
  })

  it('canonicalizes set-like ordering while retaining payload sequence meaning', () => {
    const first = input()
    const reordered = cloneInput(first)
    reordered.arms.reverse()
    reordered.bundles.reverse()
    reordered.bundles.forEach((item) => {
      item.pages.reverse()
      item.artifacts.reverse()
      item.sources.reverse()
      item.candidates.reverse()
    })
    reordered.obligations[0]!.sourceIds.reverse()
    reordered.obligations[0]!.artifactIds.reverse()
    reordered.obligations[0]!.candidateIds.reverse()
    reordered.disagreements[0]!.candidateIds.reverse()
    reordered.disagreements[0]!.providerIds.reverse()

    const firstGraph = buildSourceEvidenceGraph(first)
    const reorderedGraph = buildSourceEvidenceGraph(reordered)
    expect(reorderedGraph).toEqual(firstGraph)
    expect(sourceEvidenceGraphSha256(reordered)).toBe(firstGraph.graphSha256)

    const changedPayloadOrder = cloneInput(first)
    const payload = changedPayloadOrder.bundles[0]!.sources[0]!.payload as {
      text: string
      tokens: string[]
    }
    payload.tokens.reverse()
    changedPayloadOrder.deterministicContext =
      deterministicContextReceiptForBundle(changedPayloadOrder.bundles[0]!)
    expect(buildSourceEvidenceGraph(changedPayloadOrder).graphSha256).not.toBe(
      firstGraph.graphSha256,
    )
  })

  it('hashes explicit candidate sets against the graph and rejects bad sets', () => {
    const graph = buildSourceEvidenceGraph(input())
    const reader = readSourceEvidenceGraph(graph)
    const ids = ['pdfjs-bundle-candidate', 'mineru-bundle-candidate']

    expect(reader.candidateSetSha256(ids)).toBe(
      sourceEvidenceCandidateSetSha256(graph, [...ids].reverse()),
    )
    expect(() => reader.candidateSetSha256([ids[0]!, ids[0]!])).toThrow(
      /duplicate id/u,
    )
    expect(() => reader.candidateSetSha256(['unknown-candidate'])).toThrow(
      /unknown candidate/u,
    )
  })

  it('rejects same-ID deterministic source content swapped after context binding', () => {
    const swapped = cloneInput()
    const sourceItem = swapped.bundles[0]!.sources[0]!
    sourceItem.payload = {
      ...(sourceItem.payload as Record<string, unknown>),
      text: 'Different text under the same source ID and PDF identity.',
    } as typeof sourceItem.payload

    expect(() => buildSourceEvidenceGraph(swapped)).toThrow(
      /deterministicContext does not match the exact normalized deterministic bundle/u,
    )
  })

  it('detects content changed after the graph hash was frozen', () => {
    const graph = buildSourceEvidenceGraph(input())
    const tampered = structuredClone(graph) as SourceEvidenceGraph
    tampered.bundles[0]!.candidates[0]!.payload = { text: 'Invented' }

    expect(() => validateSourceEvidenceGraph(tampered)).toThrow(
      /graphSha256 does not match/u,
    )
  })

  it.each([
    {
      level: 'graph',
      locate: (graph: SourceEvidenceGraph) => graph,
    },
    {
      level: 'source identity',
      locate: (graph: SourceEvidenceGraph) => graph.source,
    },
    {
      level: 'arm',
      locate: (graph: SourceEvidenceGraph) => graph.arms[0]!,
    },
    {
      level: 'bundle',
      locate: (graph: SourceEvidenceGraph) => graph.bundles[0]!,
    },
    {
      level: 'provider',
      locate: (graph: SourceEvidenceGraph) =>
        graph.bundles.find(({ provider }) => provider.kind === 'mineru')!
          .provider,
    },
    {
      level: 'provider model',
      locate: (graph: SourceEvidenceGraph) =>
        graph.bundles.find(({ provider }) => provider.kind === 'mineru')!
          .provider.model!,
    },
    {
      level: 'page',
      locate: (graph: SourceEvidenceGraph) => graph.bundles[0]!.pages[0]!,
    },
    {
      level: 'box',
      locate: (graph: SourceEvidenceGraph) =>
        graph.bundles[0]!.artifacts[0]!.box!,
    },
    {
      level: 'artifact',
      locate: (graph: SourceEvidenceGraph) => graph.bundles[0]!.artifacts[0]!,
    },
    {
      level: 'source item',
      locate: (graph: SourceEvidenceGraph) => graph.bundles[0]!.sources[0]!,
    },
    {
      level: 'candidate',
      locate: (graph: SourceEvidenceGraph) => graph.bundles[0]!.candidates[0]!,
    },
    {
      level: 'obligation',
      locate: (graph: SourceEvidenceGraph) => graph.obligations[0]!,
    },
    {
      level: 'disagreement',
      locate: (graph: SourceEvidenceGraph) => graph.disagreements[0]!,
    },
  ])('rejects unhashed extra state at the $level level', ({ locate }) => {
    const installed = structuredClone(
      buildSourceEvidenceGraph(input()),
    ) as SourceEvidenceGraph
    const oldHash = installed.graphSha256
    const target = locate(installed) as unknown as Record<string, unknown>
    target.injectedState = 'not represented by the old canonical hash'

    expect(installed.graphSha256).toBe(oldHash)
    expect(() => validateSourceEvidenceGraph(installed)).toThrow(
      /unsupported field injectedState/u,
    )
  })

  it('rejects hidden, symbolic, accessor-backed, and payload container state', () => {
    const hidden = structuredClone(
      buildSourceEvidenceGraph(input()),
    ) as SourceEvidenceGraph
    Object.defineProperty(hidden.bundles[0]!.candidates[0]!, 'hiddenState', {
      value: true,
      enumerable: false,
    })
    expect(() => validateSourceEvidenceGraph(hidden)).toThrow(
      /unsupported field hiddenState/u,
    )

    const symbolic = structuredClone(
      buildSourceEvidenceGraph(input()),
    ) as SourceEvidenceGraph
    Object.defineProperty(symbolic.obligations[0]!, Symbol('hidden'), {
      value: true,
      enumerable: true,
    })
    expect(() => validateSourceEvidenceGraph(symbolic)).toThrow(
      /unsupported field Symbol\(hidden\)/u,
    )

    const accessor = structuredClone(
      buildSourceEvidenceGraph(input()),
    ) as SourceEvidenceGraph
    Object.defineProperty(accessor.bundles[0]!.candidates[0]!, 'kind', {
      get: () => 'text',
      enumerable: true,
      configurable: true,
    })
    expect(() => validateSourceEvidenceGraph(accessor)).toThrow(
      /kind must be an enumerable data property/u,
    )

    const payload = structuredClone(
      buildSourceEvidenceGraph(input()),
    ) as SourceEvidenceGraph
    Object.defineProperty(
      payload.bundles[0]!.sources[0]!.payload as object,
      'hiddenPayloadState',
      { value: true, enumerable: false },
    )
    expect(() => validateSourceEvidenceGraph(payload)).toThrow(
      /hiddenPayloadState must be an enumerable data property/u,
    )
  })

  it('rejects extra state before building a graph', () => {
    const unbuilt = input() as SourceEvidenceGraphInput & {
      installedState?: string
    }
    unbuilt.installedState = 'must not be normalized away'
    expect(() => buildSourceEvidenceGraph(unbuilt)).toThrow(
      /unsupported field installedState/u,
    )
  })

  it.each([
    {
      name: 'a mismatched bundle source',
      mutate: (value: SourceEvidenceGraphInput) => {
        value.bundles[0]!.source.sha256 = '9'.repeat(64)
      },
      expected: /source identity does not match/u,
    },
    {
      name: 'a missing page',
      mutate: (value: SourceEvidenceGraphInput) => {
        value.bundles[0]!.pages.pop()
      },
      expected: /every source page exactly once/u,
    },
    {
      name: 'an out-of-page box',
      mutate: (value: SourceEvidenceGraphInput) => {
        value.bundles[0]!.sources[0]!.box!.width = 1
      },
      expected: /exceeds normalized page bounds/u,
    },
    {
      name: 'a provider mismatch',
      mutate: (value: SourceEvidenceGraphInput) => {
        value.bundles[0]!.candidates[0]!.providerId = 'mineru-provider'
      },
      expected: /does not match bundle provider/u,
    },
    {
      name: 'a dangling candidate source',
      mutate: (value: SourceEvidenceGraphInput) => {
        value.bundles[0]!.candidates[0]!.sourceIds = ['missing-source']
      },
      expected: /unknown source/u,
    },
    {
      name: 'a duplicate global candidate id',
      mutate: (value: SourceEvidenceGraphInput) => {
        value.bundles[1]!.candidates[0]!.id =
          value.bundles[0]!.candidates[0]!.id
      },
      expected: /duplicate candidate id/u,
    },
    {
      name: 'a source-parent cycle',
      mutate: (value: SourceEvidenceGraphInput) => {
        value.bundles[0]!.sources[0]!.parentSourceIds = [
          'pdfjs-bundle-source-2',
        ]
        value.bundles[0]!.sources.push({
          id: 'pdfjs-bundle-source-2',
          providerId: 'pdfjs-provider',
          kind: 'text-run',
          page: 1,
          parentSourceIds: ['pdfjs-bundle-source'],
        })
      },
      expected: /source parent cycle/u,
    },
  ])('rejects $name', ({ mutate, expected }) => {
    const invalid = cloneInput()
    mutate(invalid)
    expect(() => buildSourceEvidenceGraph(invalid)).toThrow(expected)
  })

  it('requires optional-arm state to be frozen before the evidence run', () => {
    const disabledWithBundle = cloneInput()
    disabledWithBundle.arms[1] = {
      id: 'mineru',
      requirement: 'optional',
      status: 'disabled',
      frozen: true,
      reason: 'operator disabled it before the run',
    }
    expect(() => buildSourceEvidenceGraph(disabledWithBundle)).toThrow(
      /required evidence arm mineru/u,
    )

    const enabledWithoutBundle = cloneInput()
    enabledWithoutBundle.bundles.pop()
    expect(() => buildSourceEvidenceGraph(enabledWithoutBundle)).toThrow(
      /must have exactly one evidence bundle/u,
    )

    const notFrozen = cloneInput()
    ;(notFrozen.arms[2] as { frozen: boolean }).frozen = false
    expect(() => buildSourceEvidenceGraph(notFrozen)).toThrow(
      /frozen must be true/u,
    )
  })

  it('requires deterministic and MinerU arms independently of caller declarations', () => {
    const missingMineru = cloneInput()
    missingMineru.arms.splice(1, 1)
    missingMineru.bundles.splice(1, 1)
    missingMineru.obligations[0]!.sourceIds = ['pdfjs-bundle-source']
    missingMineru.obligations[0]!.artifactIds = ['pdfjs-bundle-artifact']
    missingMineru.obligations[0]!.candidateIds = ['pdfjs-bundle-candidate']
    missingMineru.disagreements = []
    expect(() => buildSourceEvidenceGraph(missingMineru)).toThrow(
      /required evidence arm mineru/u,
    )

    const callerDowngradedMineru = cloneInput()
    callerDowngradedMineru.arms[1]!.requirement = 'optional'
    expect(() => buildSourceEvidenceGraph(callerDowngradedMineru)).toThrow(
      /required evidence arm mineru/u,
    )
  })

  it('rejects empty required evidence arms and the historical partial-graph attack', () => {
    const emptyMineru = cloneInput()
    emptyMineru.bundles[1]!.sources = []
    emptyMineru.bundles[1]!.artifacts = []
    emptyMineru.bundles[1]!.candidates = []
    emptyMineru.obligations[0]!.sourceIds = ['pdfjs-bundle-source']
    emptyMineru.obligations[0]!.artifactIds = ['pdfjs-bundle-artifact']
    emptyMineru.obligations[0]!.candidateIds = ['pdfjs-bundle-candidate']
    emptyMineru.disagreements = []
    expect(() => buildSourceEvidenceGraph(emptyMineru)).toThrow(
      /required arm mineru.*must contain evidence/u,
    )

    const partial18 = cloneInput()
    const mineru = partial18.bundles[1]!
    for (let index = 1; index <= 18; index += 1) {
      const id = `partial-${index}`
      mineru.sources.push({
        id: `${id}-source`,
        providerId: mineru.provider.id,
        kind: 'text-run',
        page: 1,
        box: box(1, 0.2),
      })
      mineru.artifacts.push({
        id: `${id}-artifact`,
        providerId: mineru.provider.id,
        kind: 'content-list-json',
        mediaType: 'application/json',
        sha256: index.toString(16).padStart(64, '0'),
        byteLength: 1,
        page: 1,
      })
      mineru.candidates.push({
        id: `${id}-candidate`,
        providerId: mineru.provider.id,
        kind: 'text',
        page: 1,
        sourceIds: [`${id}-source`],
        artifactIds: [`${id}-artifact`],
      })
    }
    expect(() => buildSourceEvidenceGraph(partial18)).toThrow(
      /candidate partial-1-candidate is not owned by an obligation/u,
    )
  })

  it('requires every candidate, source fact, and artifact to be owned exactly once', () => {
    const uncoveredCandidate = cloneInput()
    uncoveredCandidate.obligations[0]!.candidateIds = [
      'pdfjs-bundle-candidate',
    ]
    expect(() => buildSourceEvidenceGraph(uncoveredCandidate)).toThrow(
      /candidate mineru-bundle-candidate is not owned by an obligation/u,
    )

    const uncoveredSource = cloneInput()
    uncoveredSource.obligations[0]!.sourceIds = ['pdfjs-bundle-source']
    expect(() => buildSourceEvidenceGraph(uncoveredSource)).toThrow(
      /source mineru-bundle-source is not owned by an obligation/u,
    )

    const uncoveredArtifact = cloneInput()
    uncoveredArtifact.obligations[0]!.artifactIds = ['pdfjs-bundle-artifact']
    expect(() => buildSourceEvidenceGraph(uncoveredArtifact)).toThrow(
      /artifact mineru-bundle-artifact is not owned by an obligation/u,
    )

    const duplicate = cloneInput()
    duplicate.bundles[0]!.sources.push({
      id: 'duplicate-owner-source',
      providerId: 'pdfjs-provider',
      kind: 'ownership-fixture',
      page: 1,
    })
    duplicate.bundles[0]!.artifacts.push({
      id: 'duplicate-owner-artifact',
      providerId: 'pdfjs-provider',
      kind: 'ownership-fixture',
      mediaType: 'application/json',
      sha256: 'f'.repeat(64),
      byteLength: 1,
      page: 1,
    })
    duplicate.bundles[0]!.candidates.push({
      id: 'duplicate-owner-fixture-candidate',
      providerId: 'pdfjs-provider',
      kind: 'ownership-fixture',
      page: 1,
      sourceIds: ['duplicate-owner-source'],
      artifactIds: ['duplicate-owner-artifact'],
    })
    duplicate.obligations.push({
      id: 'duplicate-ownership',
      kind: 'ownership-fixture',
      page: 1,
      sourceIds: ['duplicate-owner-source'],
      artifactIds: ['duplicate-owner-artifact'],
      candidateIds: [
        'pdfjs-bundle-candidate',
        'duplicate-owner-fixture-candidate',
      ],
      observationCategories: ['object-counts'],
      required: true,
      semantic: true,
    })
    expect(() => buildSourceEvidenceGraph(duplicate)).toThrow(
      /candidate .* is owned by multiple obligations/u,
    )
  })

  it('keeps disagreements separate and validates all of their references', () => {
    const wrongProviders = cloneInput()
    wrongProviders.disagreements[0]!.providerIds = ['pdfjs-provider']
    expect(() => buildSourceEvidenceGraph(wrongProviders)).toThrow(
      /providerIds do not match/u,
    )

    const oneCandidate = cloneInput()
    oneCandidate.disagreements[0]!.candidateIds = ['pdfjs-bundle-candidate']
    oneCandidate.disagreements[0]!.providerIds = ['pdfjs-provider']
    expect(() => buildSourceEvidenceGraph(oneCandidate)).toThrow(
      /at least two candidates/u,
    )

    const missingObligation = cloneInput()
    missingObligation.disagreements[0]!.obligationIds = ['missing-obligation']
    expect(() => buildSourceEvidenceGraph(missingObligation)).toThrow(
      /unknown obligation/u,
    )
  })

  it('allows a relationship candidate to carry source boxes from several pages', () => {
    const multiPage = cloneInput()
    multiPage.bundles[0]!.candidates[0]!.kind = 'citation-relationship'
    multiPage.bundles[0]!.candidates[0]!.boxes = [box(1, 0.1), box(2, 0.2)]
    multiPage.deterministicContext = deterministicContextReceiptForBundle(
      multiPage.bundles[0]!,
    )

    expect(() => buildSourceEvidenceGraph(multiPage)).not.toThrow()
  })
})
