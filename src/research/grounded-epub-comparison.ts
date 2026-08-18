import type { StructBlock, StructDocument } from '../struct/types'
import {
  hashRenderedActualObservationSet,
  hashRenderedEpubEvidence,
  hashTraceValue,
  type DeterministicComparisonObservation,
  type RenderedActualObservationSet,
  type RenderedEpubEvidence,
  type SourceOutputMapping,
  type StructArtifactBinding,
  type EpubArtifactBinding,
} from './reconstruction-attempt-trace'
import {
  compareSourceToRenderedEpub,
  createDeterministicObservationReceipt,
} from './source-epub-comparator'
import {
  verifyGroundedCoreMaterializationBinding,
  type GroundedStructMaterialization,
} from './grounded-struct-materializer'
import type {
  ActualProfiledEpubRender,
  EpubCheckReceipt,
} from './actual-profiled-epub'
import {
  verifyActualProfiledEpubRender,
  verifyEpubCheckReceipt,
} from './actual-profiled-epub'
import type { ProfiledStructEpubArtifact } from './reconstruction-materialization'
import type {
  SourceEvidenceContract,
  VerifiedExpectedObservationSet,
} from './source-evidence-contract'

export const GROUNDED_EPUB_COMPARISON_SCHEMA_VERSION = '1.0.0' as const

type VerifiedActualObservationSet = RenderedActualObservationSet & {
  payloadBytes: Uint8Array
}

export type GroundedProfiledEpubComparison = {
  schemaVersion: typeof GROUNDED_EPUB_COMPARISON_SCHEMA_VERSION
  profileId: ProfiledStructEpubArtifact['profileId']
  structure: StructArtifactBinding
  epub: EpubArtifactBinding
  renderedEpub: RenderedEpubEvidence
  actualObservationSets: VerifiedActualObservationSet[]
  mappings: SourceOutputMapping[]
  observations: DeterministicComparisonObservation[]
  comparator: ReturnType<typeof compareSourceToRenderedEpub>
  receiptSha256: string
}

function invalid(code: string): never {
  throw new Error(code)
}

function normalizedText(value: string) {
  return value.replace(/\s+/gu, ' ').trim()
}

function htmlScope(
  value: NonNullable<StructBlock['table']>['cells'][number]['headerScope'],
) {
  return value === 'column' ? 'col' : value
}

function blockFact(render: ActualProfiledEpubRender, block: StructBlock) {
  const facts = render.blockFacts.filter(({ blockId }) => blockId === block.id)
  if (facts.length !== 1) invalid('ACTUAL_RENDER_BLOCK_CARDINALITY_MISMATCH')
  return facts[0]!
}

function exactTableCells(block: StructBlock, render: ActualProfiledEpubRender) {
  const actual = blockFact(render, block).cells.map(
    ({ text, rowSpan, columnSpan, tagName, scope }) => ({
      text: normalizedText(text),
      rowSpan,
      columnSpan,
      tagName,
      scope,
    }),
  )
  const expected = (block.table?.cells ?? []).map((cell) => ({
    text: normalizedText(cell.text),
    rowSpan: cell.rowSpan,
    columnSpan: cell.columnSpan,
    tagName: cell.headerScope ? 'th' : 'td',
    scope: cell.headerScope ? htmlScope(cell.headerScope) : null,
  }))
  return hashTraceValue(actual) === hashTraceValue(expected)
}

function loadedImages(block: StructBlock, render: ActualProfiledEpubRender) {
  const images = blockFact(render, block).images
  return (
    images.length > 0 &&
    images.every(
      ({ complete, naturalWidth, naturalHeight }) =>
        complete && naturalWidth > 0 && naturalHeight > 0,
    )
  )
}

function verifyCategory(
  category: string,
  block: StructBlock,
  document: StructDocument,
  render: ActualProfiledEpubRender,
) {
  const fact = blockFact(render, block)
  const factsInOrder = render.blockFacts.map(({ blockId }) => blockId)
  const expectedOrder = document.blocks
    .filter(({ kind }) => kind !== 'furniture')
    .map(({ id }) => id)
  const links = render.blockFacts.flatMap((candidate) => candidate.links)
  switch (category) {
    case 'text-exactness':
      return (
        block.text.length > 0 &&
        normalizedText(fact.text).includes(normalizedText(block.text))
      )
    case 'reading-order':
      return hashTraceValue(factsInOrder) === hashTraceValue(expectedOrder)
    case 'hierarchy':
      return (
        block.kind === 'heading' &&
        fact.tagName ===
          `h${Math.max(1, Math.min(6, Number(block.attributes?.level ?? 2)))}`
      )
    case 'object-counts':
      return render.blockFacts.length === expectedOrder.length
    case 'table-cells':
    case 'table-spans':
    case 'table-headers':
      return block.kind === 'table' && exactTableCells(block, render)
    case 'figures':
      return block.kind === 'figure' && loadedImages(block, render)
    case 'diagrams':
      return (
        block.kind === 'figure' &&
        (block.fallbackAssetIds ?? []).some((id) =>
          document.assets.some(
            (asset) => asset.id === id && asset.kind === 'diagram',
          ),
        ) &&
        loadedImages(block, render)
      )
    case 'captions':
      return (
        block.kind === 'caption' ||
        ((block.kind === 'figure' || block.kind === 'table') &&
          normalizedText(fact.text).includes(normalizedText(block.text)))
      )
    case 'formulas':
      return (
        block.kind === 'equation' &&
        (fact.images.length > 0
          ? loadedImages(block, render)
          : block.text.length > 0)
      )
    case 'code-preformatted':
      return block.kind === 'code' && fact.tagName === 'pre'
    case 'notes':
      return (
        block.kind === 'footnote' ||
        block.kind === 'endnote' ||
        document.relationships.some(
          ({ kind, from }) =>
            from === block.id && (kind === 'footnote' || kind === 'endnote'),
        )
      )
    case 'citations':
      return document.relationships.some(
        ({ kind, from, status }) =>
          kind === 'citation' && from === block.id && status === 'matched',
      )
    case 'links':
      return fact.links.length > 0
    case 'asset-bytes':
      return (
        (block.fallbackAssetIds ?? []).length > 0 && loadedImages(block, render)
      )
    case 'clipping':
      return render.metrics.clippedElementCount === 0
    case 'overflow':
      return !render.metrics.horizontalOverflow
    case 'dangling-targets':
      return links
        .filter(({ href }) => href.startsWith('#'))
        .every(({ href }) => render.anchors.includes(href.slice(1)))
    default:
      invalid('UNKNOWN_SOURCE_OBSERVATION_CATEGORY')
  }
}

function verifyGroundedActualObservationAuthority(input: {
  materialization: GroundedStructMaterialization
  sourceContract: SourceEvidenceContract
  build: ProfiledStructEpubArtifact
  render: ActualProfiledEpubRender
  epubCheck: EpubCheckReceipt
}) {
  const { materialization, sourceContract, build, render, epubCheck } = input
  verifyGroundedCoreMaterializationBinding(materialization)
  verifyActualProfiledEpubRender(render)
  verifyEpubCheckReceipt(epubCheck)
  if (
    sourceContract.graph.graphSha256 !==
      materialization.receipt.sourceEvidenceGraphSha256 ||
    sourceContract.sourceEvidenceReceipt.sourcePdfSha256 !==
      materialization.receipt.sourcePdfSha256 ||
    hashTraceValue(build.canonicalStruct) !==
      hashTraceValue(materialization.receipt.canonicalStruct) ||
    hashTraceValue(build.epub) !== hashTraceValue(render.epub) ||
    hashTraceValue(build.epub) !== hashTraceValue(epubCheck.epub) ||
    render.profileId !== build.profileId ||
    epubCheck.status !== 'passed'
  ) {
    invalid('GROUNDED_ACTUAL_OBSERVATION_BINDING_MISMATCH')
  }
  const blockById = new Map(
    materialization.document.blocks.map((block) => [block.id, block]),
  )
  for (const binding of materialization.receipt.obligationBindings) {
    const block = blockById.get(binding.outputBlockId)
    if (
      !block ||
      !render.anchors.includes(block.id) ||
      !render.locators.some(({ anchorId }) => anchorId === block.id) ||
      binding.sourceAnchorIds.some(
        (anchorId) =>
          !render.anchors.includes(anchorId) ||
          !block.sourceObservationAnchorIds?.includes(anchorId),
      ) ||
      binding.observationCategories.some(
        (category) =>
          !verifyCategory(category, block, materialization.document, render),
      )
    ) {
      invalid('ACTUAL_RENDER_SOURCE_OBSERVATION_MISMATCH')
    }
  }
}

function actualObservationSet(
  expected: VerifiedExpectedObservationSet,
): VerifiedActualObservationSet {
  const base = {
    check: expected.check,
    setSha256: expected.setSha256,
    itemCount: expected.itemCount,
    payload: structuredClone(expected.payload),
  }
  return {
    ...base,
    payloadBytes: expected.payloadBytes.slice(),
    receiptSha256: hashRenderedActualObservationSet({
      ...base,
      receiptSha256: '0'.repeat(64),
    }),
  }
}

function buildMappings(input: {
  materialization: GroundedStructMaterialization
  sourceContract: SourceEvidenceContract
  render: ActualProfiledEpubRender
}) {
  const { materialization, sourceContract, render } = input
  const bindings = new Map(
    materialization.receipt.obligationBindings.map((binding) => [
      binding.obligationId,
      binding,
    ]),
  )
  const screenshotId = `render-${render.profileId}`
  const viewport = {
    ...render.screenshotDimensions,
    deviceScaleFactor: render.viewport.deviceScaleFactor,
  }
  return sourceContract.sourceRegions.map((region): SourceOutputMapping => {
    const binding = bindings.get(region.id)
    const locator = binding
      ? render.locators.find(
          ({ anchorId }) => anchorId === binding.outputBlockId,
        )
      : null
    if (!binding || !locator) invalid('MISSING_ACTUAL_RENDER_MAPPING')
    const rect = locator.rect
    if (
      rect.x < 0 ||
      rect.y < 0 ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.x + rect.width > viewport.width + 1 ||
      rect.y + rect.height > viewport.height + 1
    ) {
      invalid('OUT_OF_BOUNDS_ACTUAL_RENDER_MAPPING')
    }
    return {
      id: `mapping-${region.id}`,
      obligationId: region.id,
      source: structuredClone(region.source),
      output: [
        {
          spineHref: 'content.xhtml',
          anchorId: binding.outputBlockId,
          rendered: {
            screenshotId,
            viewport,
            rect,
            scrollOffset: { x: 0, y: 0 },
          },
        },
      ],
      status: 'mapped',
    }
  })
}

function comparisonProjection(
  comparison: Omit<GroundedProfiledEpubComparison, 'receiptSha256'>,
) {
  return {
    ...comparison,
    actualObservationSets: comparison.actualObservationSets.map(
      ({ payloadBytes: _payloadBytes, ...set }) => set,
    ),
  }
}

/**
 * Replay #198 expected sets only after the exact candidate-grounded STRUCT,
 * packaged bytes, browser DOM, screenshot locators, and EPUBCheck receipt have
 * all been independently bound.
 */
export function compareGroundedProfiledEpub(input: {
  materialization: GroundedStructMaterialization
  sourceContract: SourceEvidenceContract
  build: ProfiledStructEpubArtifact
  render: ActualProfiledEpubRender
  epubCheck: EpubCheckReceipt
}): GroundedProfiledEpubComparison {
  verifyGroundedActualObservationAuthority(input)
  const { materialization, sourceContract, build, render, epubCheck } = input
  const structure: StructArtifactBinding = {
    schemaVersion: materialization.document.schemaVersion,
    documentId: materialization.receipt.documentId,
    sourcePdfSha256: materialization.document.source.sha256,
    artifact: build.canonicalStruct,
    generatedSha256: materialization.document.receipt.generatedSha256,
    assets: materialization.document.assets.map(({ id, sha256, bytes }) => ({
      id,
      sha256,
      byteLength: bytes?.byteLength ?? 0,
    })),
  }
  const epub: EpubArtifactBinding = {
    bytes: build.epub,
    mediaType: 'application/epub+zip',
    structSha256: build.canonicalStruct.sha256,
    epubCheck: {
      toolId: epubCheck.toolId,
      toolVersion: epubCheck.toolVersion,
      reportSha256: epubCheck.report.sha256,
      status: 'passed',
      errorCount: 0,
      warningCount: 0,
    },
  }
  const actualObservationSets =
    sourceContract.expectedObservationSets.map(actualObservationSet)
  const sourceObligations = structuredClone(
    sourceContract.sourceEvidenceReceipt.sourceObligations,
  )
  const renderedBase: Omit<RenderedEpubEvidence, 'receiptSha256'> = {
    epubSha256: build.epub.sha256,
    download: {
      artifact: structuredClone(build.epub),
      verificationReceiptSha256: hashTraceValue({
        profileId: build.profileId,
        epub: build.epub,
        renderReceiptSha256: render.receiptSha256,
      }),
    },
    sourceObligations: {
      sourcePdfSha256: materialization.document.source.sha256,
      ...sourceObligations,
    },
    actualObservationSets: actualObservationSets.map(
      ({ payloadBytes: _payloadBytes, ...set }) => set,
    ),
    renderer: {
      id: render.renderer.id,
      version: `${render.renderer.packageVersion}/${render.renderer.browserVersion}`,
      executableSha256: render.renderer.executableSha256,
      configurationSha256: hashTraceValue({
        profileId: render.profileId,
        viewport: render.viewport,
        schemaVersion: render.schemaVersion,
      }),
    },
    domSnapshots: [
      {
        spineHref: 'content.xhtml',
        dom: render.dom,
        anchors: [...render.anchors],
      },
    ],
    screenshots: [
      {
        id: `render-${render.profileId}`,
        spineHref: 'content.xhtml',
        domSha256: render.dom.sha256,
        image: render.screenshot,
        mediaType: 'image/png',
        width: render.screenshotDimensions.width,
        height: render.screenshotDimensions.height,
        viewport: {
          ...render.screenshotDimensions,
          deviceScaleFactor: render.viewport.deviceScaleFactor,
        },
        fullPage: true,
      },
    ],
  }
  const renderedEpub: RenderedEpubEvidence = {
    ...renderedBase,
    receiptSha256: hashRenderedEpubEvidence({
      ...renderedBase,
      receiptSha256: '0'.repeat(64),
    }),
  }
  const mappings = buildMappings({ materialization, sourceContract, render })
  const bindingByObligation = new Map(
    materialization.receipt.obligationBindings.map((binding) => [
      binding.obligationId,
      binding,
    ]),
  )
  const observations = sourceContract.expectedObservationSets.map(
    (expected, index) => {
      const mappingIds = sourceContract.sourceRegions
        .filter((region) =>
          bindingByObligation
            .get(region.id)
            ?.observationCategories.includes(expected.check),
        )
        .map(({ id }) => `mapping-${id}`)
      const selectedMappingIds =
        mappingIds.length > 0 ? mappingIds : [mappings[0]!.id]
      const source = mappings.find(
        ({ id }) => id === selectedMappingIds[0],
      )!.source
      return createDeterministicObservationReceipt({
        idSha256: hashTraceValue({
          profileId: build.profileId,
          check: expected.check,
        }),
        check: expected.check,
        source,
        mappingIds: selectedMappingIds,
        expectedSetReceiptSha256: expected.receiptSha256,
        actualSetReceiptSha256: actualObservationSets[index]!.receiptSha256,
      })
    },
  )
  const comparator = compareSourceToRenderedEpub({
    sourcePdfSha256: materialization.document.source.sha256,
    sourceEvidence: sourceContract.sourceEvidenceReceipt,
    structure,
    epub,
    renderedEpub,
    sourceRegions: sourceContract.sourceRegions,
    mappings,
    observations,
  })
  const projection = comparisonProjection({
    schemaVersion: GROUNDED_EPUB_COMPARISON_SCHEMA_VERSION,
    profileId: build.profileId,
    structure,
    epub,
    renderedEpub,
    actualObservationSets,
    mappings,
    observations,
    comparator,
  })
  return {
    schemaVersion: GROUNDED_EPUB_COMPARISON_SCHEMA_VERSION,
    profileId: build.profileId,
    structure,
    epub,
    renderedEpub,
    actualObservationSets,
    mappings,
    observations,
    comparator,
    receiptSha256: hashTraceValue(projection),
  }
}
