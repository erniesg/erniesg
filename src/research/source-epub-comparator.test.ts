import { describe, expect, it } from 'vitest'
import { sha256HexSync } from './sha256-sync'
import {
  DETERMINISTIC_CHECK_IDS,
  encodeCanonicalObservationPayload,
  hashRenderedActualObservationSet,
  hashRenderedEpubEvidence,
  hashSourceEvidenceReceipt,
  hashSourceExpectedObservationSet,
  hashTraceValue,
  type RenderedEpubEvidence,
  type SourceLocation,
} from './reconstruction-attempt-trace'
import {
  SOURCE_EPUB_OBSERVATION_CHECK_IDS,
  compareSourceToRenderedEpub,
  createDeterministicObservationReceipt,
  type SourceEpubComparisonInput,
} from './source-epub-comparator'

const digest = (value: string) => hashTraceValue(value)
const spineHref = 'EPUB/content.xhtml'
const viewport = { width: 800, height: 1_000, deviceScaleFactor: 1 }
const source: SourceLocation = {
  page: 2,
  boxes: [{ page: 2, x: 10, y: 20, width: 300, height: 400, rotation: 0 }],
  sourceRegionIds: ['region-1'],
}

function observationPayload(
  check: (typeof SOURCE_EPUB_OBSERVATION_CHECK_IDS)[number],
  labels: string[],
) {
  const bytes = encodeCanonicalObservationPayload({
    schemaVersion: '1.0.0',
    check,
    items: labels.map((label) => ({
      idSha256: digest(`item-${check}-${label}`),
      valueSha256: digest(`value-${check}-${label}`),
      anchorIds: ['struct-figure-1'],
    })),
  })
  return { sha256: sha256HexSync(bytes), byteLength: bytes.byteLength }
}

function renderedReceipt({
  sourcePdfSha256,
  epubSha256,
  sourceRegions,
  actualObservationSets,
}: {
  sourcePdfSha256: string
  epubSha256: string
  sourceRegions: SourceEpubComparisonInput['sourceRegions']
  actualObservationSets: RenderedEpubEvidence['actualObservationSets']
}): RenderedEpubEvidence {
  const obligationProjection = {
    sourcePdfSha256,
    obligationsSha256: hashTraceValue(sourceRegions),
    obligationCount: sourceRegions.length,
  }
  const withoutReceipt: Omit<RenderedEpubEvidence, 'receiptSha256'> = {
    epubSha256,
    download: {
      artifact: { sha256: epubSha256, byteLength: 500 },
      verificationReceiptSha256: digest('download-verification'),
    },
    sourceObligations: {
      ...obligationProjection,
      receiptSha256: hashTraceValue(obligationProjection),
    },
    actualObservationSets,
    renderer: {
      id: 'chromium',
      version: '1',
      configurationSha256: digest('render-config'),
    },
    domSnapshots: [
      {
        spineHref,
        dom: { sha256: digest('rendered-dom'), byteLength: 200 },
        anchors: ['struct-figure-1'],
      },
    ],
    screenshots: [
      {
        id: 'screen-1',
        spineHref,
        domSha256: digest('rendered-dom'),
        image: { sha256: digest('screen'), byteLength: 800 },
        mediaType: 'image/png',
        width: 800,
        height: 1_000,
        viewport,
        fullPage: true,
      },
    ],
  }
  const candidate = {
    ...withoutReceipt,
    receiptSha256: digest('placeholder'),
  }
  candidate.receiptSha256 = hashRenderedEpubEvidence(candidate)
  return candidate
}

function comparisonInput(): SourceEpubComparisonInput {
  const sourcePdfSha256 = digest('source-pdf')
  const structSha256 = digest('struct')
  const epubSha256 = digest('epub')
  const sourceRegions = [{ id: 'region-1', source }]
  const obligationProjection = {
    sourcePdfSha256,
    obligationsSha256: hashTraceValue(sourceRegions),
    obligationCount: sourceRegions.length,
  }
  const expectedObservationSets = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map(
    (check) => {
      const payload = observationPayload(check, [`source-${check}`])
      const projection = {
        check,
        setSha256: payload.sha256,
        itemCount: 1,
        payload,
        sourceRegionIds: ['region-1'],
      }
      return {
        ...projection,
        receiptSha256: hashTraceValue(projection),
      }
    },
  )
  const actualObservationSets = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map(
    (check) => {
      const payload = observationPayload(check, [`source-${check}`])
      const projection = {
        check,
        setSha256: payload.sha256,
        itemCount: 1,
        payload,
      }
      return {
        ...projection,
        receiptSha256: hashTraceValue(projection),
      }
    },
  )
  const sourceEvidenceWithoutReceipt = {
    schemaVersion: '1.0.0',
    sourcePdfSha256,
    evidenceGraphSha256: digest('evidence-graph'),
    candidateSetSha256: digest('candidate-set'),
    sourceObligations: {
      obligationsSha256: obligationProjection.obligationsSha256,
      obligationCount: obligationProjection.obligationCount,
      receiptSha256: hashTraceValue(obligationProjection),
    },
    expectedObservationSets,
  }
  const sourceEvidence = {
    ...sourceEvidenceWithoutReceipt,
    receiptSha256: hashTraceValue(sourceEvidenceWithoutReceipt),
  }
  const renderedEpub = renderedReceipt({
    sourcePdfSha256,
    epubSha256,
    sourceRegions,
    actualObservationSets,
  })
  const mappings: SourceEpubComparisonInput['mappings'] = [
    {
      id: 'mapping-1',
      obligationId: 'obligation-1',
      source,
      output: [
        {
          spineHref,
          anchorId: 'struct-figure-1',
          rendered: {
            screenshotId: 'screen-1',
            viewport,
            rect: { x: 10, y: 20, width: 300, height: 400 },
          },
        },
      ],
      status: 'mapped',
    },
  ]
  return {
    sourcePdfSha256,
    sourceEvidence,
    structure: {
      schemaVersion: '0.2.0',
      documentId: 'document-1',
      sourcePdfSha256,
      artifact: { sha256: structSha256, byteLength: 300 },
      generatedSha256: digest('generated-struct'),
      assets: [],
    },
    epub: {
      bytes: { sha256: epubSha256, byteLength: 500 },
      mediaType: 'application/epub+zip',
      structSha256,
      epubCheck: {
        toolId: 'epubcheck',
        toolVersion: '5.3.0',
        reportSha256: digest('epubcheck-report'),
        status: 'passed',
        errorCount: 0,
        warningCount: 0,
      },
    },
    renderedEpub,
    sourceRegions,
    mappings,
    observations: SOURCE_EPUB_OBSERVATION_CHECK_IDS.map((check) =>
      createDeterministicObservationReceipt({
        idSha256: digest(`observation-${check}`),
        check,
        mappingIds: ['mapping-1'],
        expectedSetReceiptSha256: expectedObservationSets.find(
          (set) => set.check === check,
        )!.receiptSha256,
        actualSetReceiptSha256: actualObservationSets.find(
          (set) => set.check === check,
        )!.receiptSha256,
      }),
    ),
  }
}

function mismatch(
  check: (typeof SOURCE_EPUB_OBSERVATION_CHECK_IDS)[number],
) {
  const input = comparisonInput()
  const index = input.observations.findIndex(
    (candidate) => candidate.check === check,
  )
  const observation = input.observations[index]!
  const { receiptSha256: _receiptSha256, ...observationCore } = observation
  const actual = input.renderedEpub.actualObservationSets.find(
    (candidate) => candidate.check === check,
  )!
  actual.payload = observationPayload(check, [])
  actual.setSha256 = actual.payload.sha256
  actual.itemCount = 0
  actual.receiptSha256 = hashRenderedActualObservationSet(actual)
  input.renderedEpub.receiptSha256 = hashRenderedEpubEvidence(
    input.renderedEpub,
  )
  input.observations[index] = createDeterministicObservationReceipt({
    ...observationCore,
    source,
    actualSetReceiptSha256: actual.receiptSha256,
  })
  return compareSourceToRenderedEpub(input)
}

describe('source to rendered EPUB comparator', () => {
  it('passes only a complete hash-bound renderer and source receipt set', () => {
    const result = compareSourceToRenderedEpub(comparisonInput())

    expect(result.status).toBe('publication-ready')
    expect(new Set(result.checkResults.map(({ check }) => check))).toEqual(
      new Set(DETERMINISTIC_CHECK_IDS),
    )
    expect(result.denominator).toBe(result.passed)
    expect(result.renderObservationReceiptSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects zero-observation self-attestation for source-bearing evidence', () => {
    const raw = comparisonInput() as unknown as {
      observations: Array<Record<string, unknown>>
    }
    raw.observations = SOURCE_EPUB_OBSERVATION_CHECK_IDS.map((check) => ({
      idSha256: digest(`raw-${check}`),
      check,
      mappingIds: ['mapping-1'],
      expected: [],
      actual: [],
    }))
    expect(() => compareSourceToRenderedEpub(raw)).toThrow(
      /required/iu,
    )

    const unproved = comparisonInput()
    const expected = unproved.sourceEvidence.expectedObservationSets[0]!
    expected.payload = observationPayload(expected.check, [])
    expected.setSha256 = expected.payload.sha256
    expected.itemCount = 0
    expected.receiptSha256 = hashSourceExpectedObservationSet(expected)
    unproved.sourceEvidence.receiptSha256 = hashSourceEvidenceReceipt(
      unproved.sourceEvidence,
    )
    const observation = unproved.observations.find(
      ({ check }) => check === expected.check,
    )!
    const { receiptSha256: _receiptSha256, ...observationCore } = observation
    Object.assign(
      observation,
      createDeterministicObservationReceipt({
        ...observationCore,
        expectedSetReceiptSha256: expected.receiptSha256,
      }),
    )
    expect(() => compareSourceToRenderedEpub(unproved)).toThrow(/self-attests zero/iu)
  })

  it.each([
    'figures',
    'captions',
    'reading-order',
    'code-preformatted',
  ] as const)('fails and locates a proven %s mismatch', (check) => {
    const result = mismatch(check)
    const firstCause = result.failures.find(
      ({ id }) => id === result.firstCauseFailureId,
    )
    expect(result.status).toBe('failed')
    expect(firstCause).toMatchObject({ check, mappingIds: ['mapping-1'] })
  })

  it('rejects nonexistent anchors and empty or out-of-bounds locators', () => {
    const missingAnchor = comparisonInput()
    missingAnchor.mappings[0]!.output[0]!.anchorId = 'missing-anchor'
    expect(() => compareSourceToRenderedEpub(missingAnchor)).toThrow(
      /nonexistent anchor/iu,
    )

    const zeroArea = comparisonInput()
    zeroArea.mappings[0]!.output[0]!.rendered!.rect.width = 0
    expect(() => compareSourceToRenderedEpub(zeroArea)).toThrow(/empty/iu)

    const outOfBounds = comparisonInput()
    outOfBounds.mappings[0]!.output[0]!.rendered!.rect.x = 700
    outOfBounds.mappings[0]!.output[0]!.rendered!.rect.width = 200
    expect(() => compareSourceToRenderedEpub(outOfBounds)).toThrow(
      /out-of-bounds/iu,
    )
  })

  it('rejects stale render/source receipts and fails EPUBCheck warnings', () => {
    const staleRender = comparisonInput()
    staleRender.renderedEpub.download.artifact.sha256 = digest('other-epub')
    expect(() => compareSourceToRenderedEpub(staleRender)).toThrow(
      /downloaded EPUB/iu,
    )

    const staleSource = comparisonInput()
    staleSource.renderedEpub.sourceObligations.obligationCount = 2
    staleSource.renderedEpub.receiptSha256 = hashRenderedEpubEvidence(
      staleSource.renderedEpub,
    )
    expect(() => compareSourceToRenderedEpub(staleSource)).toThrow(
      /source-obligation/iu,
    )

    const warning = comparisonInput()
    warning.epub.epubCheck.warningCount = 1
    expect(compareSourceToRenderedEpub(warning).failures[0]).toMatchObject({
      check: 'epub-package',
    })
  })
})
