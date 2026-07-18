import { resolveTextAnchor, type TextAnnotation } from './annotations'
import { canonicalNodeContentHash, type ResearchPaper } from './schema'
import { TARGET_PROFILE_IDS, type TargetProfileId } from './targets'
import { validateLayoutManifest, type LayoutManifest } from './manifest'

export const SRT_EVALUATION_SCHEMA_VERSION = '1.0.0' as const

export type GeometryTargetReport = {
  target: string
  missingNodes: string[]
  invalidFragmentLineage: string[]
  textLoss: string[]
  clippedContent: string[]
  overlaps: string[]
  orphanedCaptions: string[]
  horizontalOverflow: Array<{ element: string; amount: number }>
}

export type GeometryEvidence = {
  schemaVersion: '1.0.0'
  runtime: {
    browserName: 'chromium'
    browserVersion: string
    viewport: { width: number; height: number }
    deviceScaleFactor: number
  }
  tolerances: {
    geometryCssPx: number
    overflowCssPx: number
  }
  targets: GeometryTargetReport[]
}

export type CompositionTiming = {
  coldMs: number
  warmIterations: number
  warmMedianMs: number
  warmP95Ms: number
}

export type EvaluationRuntime = {
  generatedAt: string
  node: string
  v8: string
  platform: string
  architecture: string
  osRelease: string
  cpuModel: string
  logicalCpuCount: number
  totalMemoryMiB: number
}

type FixedPdfEvidence = {
  pageCount: number
  byteLength: number
  sha256: string
}

type EvaluationInput = {
  paper: ResearchPaper
  manifest: LayoutManifest
  annotations: readonly TextAnnotation[]
  geometry: GeometryEvidence
  timings: Record<TargetProfileId, CompositionTiming>
  runtime: EvaluationRuntime
  fixedPdf: FixedPdfEvidence
}

type RelationshipEdge = {
  source: string
  predicate: 'caption' | 'noteTargets' | 'backlinks'
  target: string
}

function relationshipEdgesForPaper(paper: ResearchPaper) {
  const edges: RelationshipEdge[] = []
  for (const node of paper.nodes) {
    if (node.type === 'figure') {
      edges.push({
        source: node.id,
        predicate: 'caption',
        target: node.relationships.caption,
      })
    }
    if ('noteReferences' in node) {
      for (const reference of node.noteReferences ?? []) {
        edges.push({
          source: node.id,
          predicate: 'noteTargets',
          target: reference.target,
        })
      }
    }
    if (node.type === 'footnote') {
      for (const backlink of node.relationships.backlinks) {
        edges.push({
          source: node.id,
          predicate: 'backlinks',
          target: backlink,
        })
      }
    }
  }
  return edges
}

function relationshipEdgesForRendition(
  rendition: LayoutManifest['renditions'][number],
) {
  const edges: RelationshipEdge[] = []
  for (const entry of rendition.entries) {
    for (const [predicate, value] of Object.entries(entry.relationships)) {
      for (const target of Array.isArray(value) ? value : [value]) {
        if (
          predicate === 'caption' ||
          predicate === 'noteTargets' ||
          predicate === 'backlinks'
        ) {
          edges.push({
            source: entry.canonicalId,
            predicate,
            target,
          })
        }
      }
    }
  }
  return edges
}

function edgeKey(edge: RelationshipEdge) {
  return `${edge.source}\u0000${edge.predicate}\u0000${edge.target}`
}

function ratio(preserved: number, expected: number) {
  return expected === 0 ? 1 : preserved / expected
}

export function evaluateSrt(input: EvaluationInput) {
  const manifest = validateLayoutManifest(input.manifest, input.paper)
  const expectedEdges = relationshipEdgesForPaper(input.paper)
  const expectedEdgeKeys = new Set(expectedEdges.map(edgeKey))
  const expectedNodeIds = new Set(input.paper.nodes.map((node) => node.id))
  const geometryByTarget = new Map(
    input.geometry.targets.map((report) => [report.target, report]),
  )
  if (
    input.geometry.schemaVersion !== '1.0.0' ||
    input.geometry.targets.length !== TARGET_PROFILE_IDS.length ||
    geometryByTarget.size !== TARGET_PROFILE_IDS.length ||
    TARGET_PROFILE_IDS.some((target) => !geometryByTarget.has(target))
  ) {
    throw new Error(
      'Geometry evidence must contain each SRT target exactly once under schema 1.0.0',
    )
  }

  const targets = TARGET_PROFILE_IDS.map((target) => {
    const rendition = manifest.renditions.find(
      (candidate) => candidate.target === target,
    )
    if (!rendition) throw new Error(`Evaluation manifest omitted ${target}`)

    const entriesById = new Map(
      rendition.entries.map((entry) => [entry.canonicalId, entry]),
    )
    const preservedNodes = input.paper.nodes.filter((node) => {
      const entry = entriesById.get(node.id)
      return (
        entry?.nodeType === node.type &&
        entry.contentHash === canonicalNodeContentHash(node)
      )
    }).length
    const actualEdgeKeys = new Set(
      relationshipEdgesForRendition(rendition).map(edgeKey),
    )
    const preservedEdges = [...expectedEdgeKeys].filter((edge) =>
      actualEdgeKeys.has(edge),
    ).length
    const resolutions = input.annotations.map((annotation) =>
      resolveTextAnchor(annotation.target, input.paper.nodes),
    )
    const survivingAnnotations = resolutions.filter(
      (resolution) => resolution.status === 'resolved',
    ).length
    const stableAnchors = resolutions.filter((resolution, index) => {
      const annotation = input.annotations[index]
      return (
        resolution.status === 'resolved' &&
        resolution.nodeId === annotation.target.nodeId &&
        resolution.start === annotation.target.position.start &&
        resolution.end === annotation.target.position.end &&
        expectedNodeIds.has(resolution.nodeId) &&
        entriesById.has(resolution.nodeId)
      )
    }).length
    const geometry = geometryByTarget.get(target)
    if (!geometry) {
      throw new Error(`Geometry evidence omitted ${target}`)
    }

    return {
      target,
      structuralCoverage: {
        preserved: preservedNodes,
        expected: input.paper.nodes.length,
        ratio: ratio(preservedNodes, input.paper.nodes.length),
      },
      relationshipPreservation: {
        preserved: preservedEdges,
        expected: expectedEdges.length,
        ratio: ratio(preservedEdges, expectedEdges.length),
      },
      browserGeometry: {
        status: 'measured' as const,
        clippedElements: geometry.clippedContent.length,
        overlapPairs: geometry.overlaps.length,
        horizontalOverflows: geometry.horizontalOverflow.length,
        orphanedCaptions: geometry.orphanedCaptions.length,
        missingNodes: geometry.missingNodes.length,
        textLosses: geometry.textLoss.length,
        invalidFragmentLineages: geometry.invalidFragmentLineage.length,
      },
      annotationSurvival: {
        preserved: survivingAnnotations,
        expected: input.annotations.length,
        ratio: ratio(survivingAnnotations, input.annotations.length),
      },
      anchorStability: {
        stable: stableAnchors,
        expected: input.annotations.length,
        ratio: ratio(stableAnchors, input.annotations.length),
        basis:
          'Canonical node ID, exact quote, and resolved character range remained unchanged in the target rendition.',
      },
      fallbacks: {
        composition: rendition.entries.filter((entry) => entry.fallback).length,
        pagination: rendition.entries.filter(
          (entry) => entry.paginationFallback,
        ).length,
        total: rendition.entries.filter(
          (entry) => entry.fallback || entry.paginationFallback,
        ).length,
      },
      compositionTime: input.timings[target],
    }
  })

  return {
    schemaVersion: SRT_EVALUATION_SCHEMA_VERSION,
    subject: {
      documentId: input.paper.id,
      documentVersion: input.paper.version,
      canonicalNodes: input.paper.nodes.length,
      canonicalRelationships: expectedEdges.length,
      annotations: input.annotations.length,
      targets: TARGET_PROFILE_IDS.length,
      sampleSize: 1,
    },
    method: {
      scope:
        'Engineering POC evaluation of one trusted structured fixture across four target profiles.',
      cold: 'The first manifest composition for a target after evaluator module initialization; module loading and browser startup are excluded.',
      warm: 'Median and p95 of repeated manifest compositions in the same process after one unmeasured warm-up composition.',
      geometry:
        'Chromium DOM rectangles measured from the built Astro page after document fonts are ready, using the recorded CSS-pixel tolerances.',
    },
    runtime: input.runtime,
    browserRuntime: input.geometry.runtime,
    geometryTolerances: input.geometry.tolerances,
    targets,
    baselines: [
      {
        id: 'fixed-pdf',
        availability: 'available' as const,
        comparison: 'limited' as const,
        independence: 'same-semantic-source' as const,
        evidence: input.fixedPdf,
        note: 'The deterministic fixed PDF is generated from the same canonical fixture. It verifies a fixed-page artifact, not an independent PDF-ingestion baseline.',
      },
      {
        id: 'geometric-reflow',
        availability: 'unavailable' as const,
        comparison: 'not-run' as const,
        note: 'No same-content geometric-reflow implementation or validated output exists in this repository, so no score is reported.',
      },
      {
        id: 'semantic-rendition',
        availability: 'available' as const,
        comparison: 'measured' as const,
        targets: [...TARGET_PROFILE_IDS],
        note: 'All target metrics in this report come from the canonical graph, layout manifest, annotation resolver, and browser geometry evidence.',
      },
    ],
    novelty: {
      qualification: 'to our knowledge' as const,
      claim:
        'To our knowledge, the integrated POC remains an apparent gap identified by a targeted scoping review; this is not a systematic-review or publication novelty claim.',
      requiredBeforePublication: [
        'systematic bibliographic database search',
        'documented screening protocol',
        'backward citation chaining',
        'forward citation chaining',
      ],
    },
  }
}
