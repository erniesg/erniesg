import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  cacheAnnotationGeometry,
  createDemoAnnotations,
  createLayoutVersion,
  resolveTextAnchor,
  type TextAnchorResolution,
  type TextAnnotation,
} from '../../research/annotations'
import {
  COMPOSITION_POLICY_VERSION,
  getCompositionPolicy,
  resolveNodeComposition,
} from '../../research/composition'
import {
  measureCurrentRegionStability,
  PAGINATION_POLICY_VERSION,
  paginateResearchPaper,
  type PaginationFragment,
  type PaginationResult,
} from '../../research/pagination'
import type {
  DocumentReconstruction,
  PublicationAsset,
  PublicationVisualRelationship,
} from '../../research/import-types'
import type { ResearchNode, ResearchPaper } from '../../research/schema'
import {
  getPreviewMetrics,
  getTargetProfile,
  resolveTargetProfile,
  TARGET_PROFILE_IDS,
  type TargetOrientation,
  type TargetProfileId,
} from '../../research/targets'

type CaptionNode = Extract<ResearchNode, { type: 'caption' }>
type TextNode = Extract<
  ResearchNode,
  { type: 'heading' | 'paragraph' | 'quote' }
>
type PreviewVisual = {
  relationship: PublicationVisualRelationship
  assets: Array<{
    asset: PublicationAsset
    occurrence: number
    url?: string
  }>
}
type ResolvedTextAnnotation = {
  annotation: TextAnnotation
  resolution: Extract<TextAnchorResolution, { status: 'resolved' }>
}

function safeHref(value: string) {
  if (value.startsWith('#')) return true
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function AnnotatedText({
  text,
  range,
  annotations,
  inlineRuns,
  noteReferences,
}: {
  text: string
  range: { start: number; end: number }
  annotations: ResolvedTextAnnotation[]
  inlineRuns?: TextNode['inlineRuns']
  noteReferences?: TextNode['noteReferences']
}) {
  const relevant = annotations.filter(
    ({ resolution }) =>
      resolution.start < range.end && resolution.end > range.start,
  )
  const relevantRuns = (inlineRuns ?? []).filter(
    (run) =>
      run.start < range.end &&
      run.end > range.start &&
      run.start >= 0 &&
      run.start < run.end &&
      run.end <= text.length,
  )
  const relevantReferences = (noteReferences ?? []).filter(
    (reference) =>
      reference.start < range.end &&
      reference.end > range.start &&
      reference.start >= 0 &&
      reference.start < reference.end &&
      reference.end <= text.length,
  )
  if (
    relevant.length === 0 &&
    relevantRuns.length === 0 &&
    relevantReferences.length === 0
  ) {
    return text.slice(range.start, range.end)
  }

  const boundaries = new Set([range.start, range.end])
  for (const { resolution } of relevant) {
    boundaries.add(Math.max(range.start, resolution.start))
    boundaries.add(Math.min(range.end, resolution.end))
  }
  for (const run of relevantRuns) {
    boundaries.add(Math.max(range.start, run.start))
    boundaries.add(Math.min(range.end, run.end))
  }
  for (const reference of relevantReferences) {
    boundaries.add(Math.max(range.start, reference.start))
    boundaries.add(Math.min(range.end, reference.end))
  }
  const orderedBoundaries = [...boundaries].sort((left, right) => left - right)

  return orderedBoundaries.slice(0, -1).map((start, index) => {
    const end = orderedBoundaries[index + 1]
    const active = relevant.filter(
      ({ resolution }) => resolution.start < end && resolution.end > start,
    )
    let content: ReactNode = text.slice(start, end)
    const note = active.find(({ annotation }) => annotation.kind === 'note')
    const highlight = active.find(
      ({ annotation }) => annotation.kind === 'highlight',
    )
    const runs = relevantRuns.filter(
      (candidate) => candidate.start <= start && candidate.end >= end,
    )
    const reference = relevantReferences.find(
      (candidate) => candidate.start <= start && candidate.end >= end,
    )
    const linkRun = runs.find(
      (candidate) => candidate.href && safeHref(candidate.href),
    )

    if (runs.some((run) => run.italic)) content = <em>{content}</em>
    if (runs.some((run) => run.bold)) content = <strong>{content}</strong>
    if (runs.some((run) => run.verticalAlign === 'superscript')) {
      content = <sup>{content}</sup>
    } else if (runs.some((run) => run.verticalAlign === 'subscript')) {
      content = <sub>{content}</sub>
    }
    if (reference) {
      content = (
        <a
          id={start === reference.start ? reference.id : undefined}
          href={`#${reference.target}`}
          role="doc-noteref"
          aria-label={`Note ${reference.label}`}
        >
          {content}
        </a>
      )
    } else if (linkRun?.href) {
      content = <a href={linkRun.href}>{content}</a>
    }

    if (note?.annotation.kind === 'note') {
      content = (
        <span
          className="srt-note-target"
          data-annotation-id={note.annotation.id}
          data-annotation-kind="note"
          data-note-label="1"
          aria-describedby={`${note.annotation.id}-body`}
        >
          {content}
        </span>
      )
    }
    if (highlight?.annotation.kind === 'highlight') {
      content = (
        <mark
          className="srt-annotation-highlight"
          data-annotation-id={highlight.annotation.id}
          data-annotation-kind="highlight"
          data-anchor-node-id={highlight.resolution.nodeId}
          data-anchor-start={highlight.resolution.start}
          data-anchor-end={highlight.resolution.end}
          data-reading-anchor="true"
        >
          {content}
        </mark>
      )
    }

    return <Fragment key={`${start}-${end}`}>{content}</Fragment>
  })
}

function PreviewTable({
  node,
}: {
  node: Extract<ResearchNode, { type: 'figure' }>
}) {
  if (!node.table) return null
  return (
    <div className="srt-preview-table" role="region" aria-label={node.title}>
      <table>
        <tbody>
          {node.table.rows.map((row, rowIndex) => (
            <tr key={`${node.id}-row-${rowIndex}`}>
              {row.cells.map((cell, cellIndex) => {
                const Cell = cell.headerScope ? 'th' : 'td'
                return (
                  <Cell
                    key={`${node.id}-cell-${rowIndex}-${cellIndex}`}
                    colSpan={cell.columnSpan}
                    rowSpan={cell.rowSpan}
                    scope={
                      cell.headerScope === 'column'
                        ? 'col'
                        : cell.headerScope === 'row'
                          ? 'row'
                          : undefined
                    }
                  >
                    {cell.text}
                  </Cell>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PreviewVisualContent({
  node,
  visual,
  reconstructionProvided,
}: {
  node: Extract<ResearchNode, { type: 'figure' }>
  visual?: PreviewVisual
  reconstructionProvided: boolean
}) {
  if (!reconstructionProvided) {
    return (
      <div className="srt-pipeline" aria-label="Semantic composition pipeline">
        <span>semantic graph</span>
        <i>+</i>
        <span>target policy</span>
        <i>→</i>
        <span>rendition</span>
      </div>
    )
  }

  if (node.objectType === 'table' && node.table) {
    return <PreviewTable node={node} />
  }

  if (!visual || visual.assets.length === 0) {
    return (
      <div
        className="srt-preview-unresolved"
        role="img"
        aria-label={node.title}
      >
        Source visual unresolved · review required
      </div>
    )
  }

  return (
    <div
      className="srt-preview-assets"
      data-object-type={visual.relationship.kind}
      data-alt-source={visual.relationship.altTextSource}
    >
      {visual.assets.map(({ asset, occurrence, url }) =>
        asset.mediaType === 'application/xhtml+xml' ? (
          <span
            key={`${asset.id}:${occurrence}`}
            className="srt-preview-unresolved"
            role="img"
            aria-label={visual.relationship.altText}
            data-asset-id={asset.id}
          >
            Structured source asset available in export · safe preview requires
            a semantic table
          </span>
        ) : url ? (
          <img
            key={`${asset.id}:${occurrence}`}
            className="srt-preview-asset"
            src={url}
            alt={visual.relationship.altText}
            width={asset.width}
            height={asset.height}
            data-asset-id={asset.id}
          />
        ) : (
          <span
            key={`${asset.id}:${occurrence}`}
            className="srt-preview-asset-loading"
          >
            Preparing source visual…
          </span>
        ),
      )}
    </div>
  )
}

function usePreviewAssetUrls(reconstruction?: DocumentReconstruction) {
  const [urls, setUrls] = useState<Map<string, string>>(() => new Map())

  useEffect(() => {
    if (
      !reconstruction ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      setUrls(new Map())
      return
    }

    const next = new Map(
      reconstruction.assets
        .filter((asset) => asset.mediaType !== 'application/xhtml+xml')
        .map((asset) => [
          asset.id,
          URL.createObjectURL(
            new Blob([asset.bytes as BlobPart], { type: asset.mediaType }),
          ),
        ]),
    )
    setUrls(next)
    return () => {
      next.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [reconstruction])

  return urls
}

function fragmentData(
  fragment: PaginationFragment,
  fragmentCount: number,
  applyFallback = true,
) {
  return {
    'data-node-id': fragment.canonicalId,
    'data-fragment-id': fragment.id,
    'data-fragment-index': fragment.index,
    'data-fragment-count': fragmentCount,
    'data-page': fragment.page,
    'data-region': fragment.region,
    'data-placement-decision': fragment.decision.outcome,
    ...(fragment.fallback && applyFallback
      ? {
          'data-pagination-scale': fragment.fallback.scale,
          style: {
            '--srt-pagination-scale': fragment.fallback.scale,
          } as CSSProperties,
        }
      : {}),
  }
}

function PaperNode({
  node,
  captions,
  target,
  fragment,
  fragmentCount,
  captionFragment,
  annotations,
  visual,
  reconstructionProvided,
}: {
  node: ResearchNode
  captions: Map<string, CaptionNode>
  target: TargetProfileId
  fragment: PaginationFragment
  fragmentCount: number
  captionFragment?: PaginationFragment
  annotations: ResolvedTextAnnotation[]
  visual?: PreviewVisual
  reconstructionProvided: boolean
}) {
  const composition = resolveNodeComposition(target, node)
  const data = fragmentData(fragment, fragmentCount)

  if (node.type === 'heading') {
    return (
      <h2 {...data} data-variant={composition.chosenVariant}>
        <AnnotatedText
          text={node.text}
          range={{ start: 0, end: node.text.length }}
          annotations={annotations.filter(
            ({ resolution }) => resolution.nodeId === node.id,
          )}
          inlineRuns={node.inlineRuns}
          noteReferences={node.noteReferences}
        />
      </h2>
    )
  }
  if (node.type === 'quote') {
    return (
      <blockquote {...data} data-variant={composition.chosenVariant}>
        <AnnotatedText
          text={node.text}
          range={{ start: 0, end: node.text.length }}
          annotations={annotations.filter(
            ({ resolution }) => resolution.nodeId === node.id,
          )}
          inlineRuns={node.inlineRuns}
          noteReferences={node.noteReferences}
        />
      </blockquote>
    )
  }
  if (node.type === 'caption') return null

  if (node.type === 'footnote') {
    return (
      <aside
        {...data}
        id={node.id}
        role={node.kind === 'footnote' ? 'doc-footnote' : 'doc-endnote'}
        data-note-kind={node.kind}
        data-variant={composition.chosenVariant}
      >
        <sup>{node.label}</sup> {node.text}{' '}
        {node.relationships.backlinks.map((backlink, index) => (
          <a
            key={backlink}
            className="srt-note-backlink"
            href={`#${backlink}`}
            aria-label={`Back to reference ${index + 1}`}
          >
            ↩
          </a>
        ))}
      </aside>
    )
  }

  if (node.type === 'figure') {
    const caption = captions.get(node.relationships.caption)
    const captionData = captionFragment
      ? fragmentData(captionFragment, 1, false)
      : { 'data-node-id': node.relationships.caption }
    return (
      <figure {...data} data-variant={composition.chosenVariant}>
        <PreviewVisualContent
          node={node}
          visual={visual}
          reconstructionProvided={reconstructionProvided}
        />
        <figcaption
          {...captionData}
          id={node.relationships.caption}
          data-variant={
            caption
              ? resolveNodeComposition(target, caption).chosenVariant
              : 'figure-caption'
          }
        >
          <b>{node.title}.</b> {caption?.text}
        </figcaption>
      </figure>
    )
  }

  const range = fragment.textRange ?? { start: 0, end: node.text.length }
  return (
    <p {...data} data-variant={composition.chosenVariant}>
      <AnnotatedText
        text={node.text}
        range={range}
        annotations={annotations.filter(
          ({ resolution }) => resolution.nodeId === node.id,
        )}
        inlineRuns={node.inlineRuns}
        noteReferences={node.noteReferences}
      />
    </p>
  )
}

function DocumentHeader({
  paper,
  compact = false,
}: {
  paper: ResearchPaper
  compact?: boolean
}) {
  return (
    <header
      className="srt-document-header"
      style={compact ? { paddingBottom: 8 } : undefined}
    >
      <small style={compact ? { fontSize: 8, lineHeight: '9px' } : undefined}>
        {paper.status} paper · v{paper.version}
      </small>
      <h1
        style={
          compact
            ? { fontSize: 'calc(var(--srt-title-size) * .72)', marginTop: 6 }
            : undefined
        }
      >
        {paper.title}
      </h1>
      <p
        className="srt-subtitle"
        style={
          compact
            ? {
                fontSize: 'calc(var(--srt-subtitle-size) * .72)',
                lineHeight: 1.2,
                marginTop: 4,
              }
            : undefined
        }
      >
        {paper.subtitle}
      </p>
      <p
        className="srt-authors"
        style={
          compact
            ? { fontSize: 9, lineHeight: '10px', marginTop: 6 }
            : undefined
        }
      >
        {paper.authors.join(', ')} · updated {paper.updated}
      </p>
      <p
        className="srt-abstract"
        style={
          compact
            ? {
                fontSize: 'calc(var(--srt-abstract-size) * .72)',
                lineHeight: 1.3,
                marginTop: 8,
              }
            : undefined
        }
      >
        <b>Abstract.</b> {paper.abstract}
      </p>
    </header>
  )
}

export default function ResearchStudio({
  paper,
  reconstruction,
  initialAnnotations,
  initialProfileId = 'paperPro',
  selection,
  onSelectionChange,
}: {
  paper: ResearchPaper
  reconstruction?: DocumentReconstruction
  initialAnnotations?: TextAnnotation[]
  initialProfileId?: TargetProfileId
  selection?: {
    profileId: TargetProfileId
    orientation: TargetOrientation
  }
  onSelectionChange?: (selection: {
    profileId: TargetProfileId
    orientation: TargetOrientation
  }) => void
}) {
  const [internalProfileId, setInternalProfileId] = useState<TargetProfileId>(
    () => (reconstruction ? 'mobile' : initialProfileId),
  )
  const [internalOrientation, setInternalOrientation] =
    useState<TargetOrientation>('portrait')
  const profileId = selection?.profileId ?? internalProfileId
  const orientation = selection?.orientation ?? internalOrientation
  const profile = useMemo(
    () => resolveTargetProfile(profileId, orientation),
    [orientation, profileId],
  )
  const [widthScale, setWidthScale] = useState(1)
  const [fontScale, setFontScale] = useState(1)
  const [selected, setSelected] = useState(paper.nodes[0].id)
  const [annotations, setAnnotations] = useState<TextAnnotation[]>(
    () =>
      initialAnnotations ??
      // An imported reconstruction is a source review, not the authored demo:
      // it never receives fabricated highlights, notes, or a reading anchor.
      (reconstruction ? [] : createDemoAnnotations(paper)),
  )
  const assetUrls = usePreviewAssetUrls(reconstruction)
  const viewport = useRef<HTMLDivElement>(null)
  const previousPagination = useRef<PaginationResult | null>(null)
  const readingAnchor = annotations[0]?.target
  const stabilityNodeId = readingAnchor?.nodeId ?? paper.nodes[0].id
  const stabilityAnchor = useRef(stabilityNodeId)
  const basePagination = useMemo(() => {
    const preview = getPreviewMetrics(profile)
    return paginateResearchPaper(paper, profileId, {
      widthCssPx: preview.widthCssPx * widthScale,
      heightCssPx: preview.minHeightCssPx ?? null,
      fontScale,
      profile,
    })
  }, [fontScale, paper, profile, profileId, widthScale])
  const pagination = useMemo(() => {
    const previous = previousPagination.current
    if (!previous) return basePagination
    return {
      ...basePagination,
      currentRegionStability: measureCurrentRegionStability(
        previous,
        basePagination,
        stabilityAnchor.current,
      ),
    }
  }, [basePagination])

  const switchProfile = (next: TargetProfileId) => {
    stabilityAnchor.current = stabilityNodeId
    const nextProfile = getTargetProfile(next)
    const nextOrientation = nextProfile.orientation.supported.includes(
      orientation,
    )
      ? orientation
      : nextProfile.orientation.selected
    setInternalProfileId(next)
    setInternalOrientation(nextOrientation)
    onSelectionChange?.({ profileId: next, orientation: nextOrientation })
  }

  const switchOrientation = (next: TargetOrientation) => {
    stabilityAnchor.current = stabilityNodeId
    setInternalOrientation(next)
    onSelectionChange?.({ profileId, orientation: next })
  }

  const toggleWidth = () => {
    stabilityAnchor.current = stabilityNodeId
    setWidthScale((current) => (current === 1 ? 0.86 : 1))
  }

  const toggleFont = () => {
    stabilityAnchor.current = stabilityNodeId
    setFontScale((current) => (current === 1 ? 1.12 : 1))
  }

  useEffect(() => {
    previousPagination.current = basePagination
  }, [basePagination])

  const selectedNode =
    paper.nodes.find((node) => node.id === selected) ?? paper.nodes[0]
  const selectedPagination = pagination.nodes.find(
    (node) => node.canonicalId === selectedNode.id,
  )
  const policy = getCompositionPolicy(profileId)
  const selectedComposition = resolveNodeComposition(profileId, selectedNode)
  const preview = getPreviewMetrics(profile)
  const layoutVersion = createLayoutVersion({
    documentId: paper.id,
    documentVersion: paper.version,
    target: profileId,
    widthCssPx: pagination.constraints.widthCssPx,
    heightCssPx: pagination.constraints.heightCssPx,
    fontScale,
    compositionPolicyVersion: COMPOSITION_POLICY_VERSION,
    paginationPolicyVersion: PAGINATION_POLICY_VERSION,
  })
  const annotationResolutions = annotations.map((annotation) => ({
    annotation,
    resolution: resolveTextAnchor(annotation.target, paper.nodes),
  }))
  const resolvedAnnotations = annotationResolutions.filter(
    (item): item is ResolvedTextAnnotation =>
      item.resolution.status === 'resolved',
  )
  const readingResolution = readingAnchor
    ? resolveTextAnchor(readingAnchor, paper.nodes)
    : null
  const nodes = new Map(paper.nodes.map((node) => [node.id, node]))
  const captions = new Map(
    paper.nodes
      .filter((node): node is CaptionNode => node.type === 'caption')
      .map((node) => [node.id, node]),
  )
  const assets = new Map(
    (reconstruction?.assets ?? []).map((asset) => [asset.id, asset]),
  )
  const previewVisuals = new Map(
    (reconstruction?.visualRelationships ?? [])
      .filter(
        (relationship) =>
          relationship.status === 'matched' && relationship.canonicalNodeId,
      )
      .map((relationship) => [
        relationship.canonicalNodeId!,
        {
          relationship,
          assets: relationship.assetIds.flatMap((assetId, occurrence) => {
            const asset = assets.get(assetId)
            return asset
              ? [{ asset, occurrence, url: assetUrls.get(asset.id) }]
              : []
          }),
        },
      ]),
  )
  const availableProfileIds: readonly TargetProfileId[] = reconstruction
    ? ['mobile']
    : TARGET_PROFILE_IDS
  const paperStyle = {
    width: pagination.constraints.widthCssPx,
    maxWidth: pagination.constraints.widthCssPx,
    '--srt-page-height': pagination.constraints.heightCssPx
      ? `${pagination.constraints.heightCssPx}px`
      : 'auto',
    '--srt-header-height': `${pagination.constraints.firstPageHeaderHeightCssPx}px`,
    '--srt-margin-top': `${preview.marginTopCssPx}px`,
    '--srt-margin-right': `${preview.marginRightCssPx * widthScale}px`,
    '--srt-margin-bottom': `${preview.marginBottomCssPx}px`,
    '--srt-margin-left': `${preview.marginLeftCssPx * widthScale}px`,
    '--srt-font-family': profile.typography.fontFamily,
    '--srt-body-size': `${profile.typography.bodySizeCssPx * fontScale}px`,
    '--srt-line-height': profile.typography.lineHeight,
    '--srt-title-size': `${profile.typography.titleSizeCssPx * fontScale}px`,
    '--srt-subtitle-size': `${18 * fontScale}px`,
    '--srt-abstract-size': `${14 * fontScale}px`,
    '--srt-heading-size': `${profile.typography.headingSizeCssPx * fontScale}px`,
    '--srt-quote-size': `${profile.typography.quoteSizeCssPx * fontScale}px`,
    '--srt-caption-size': `${12 * fontScale}px`,
    '--srt-column-count': profile.columns.count,
    '--srt-column-gap': `${profile.columns.gapCssPx}px`,
  } as CSSProperties

  useEffect(() => {
    const root = viewport.current
    if (!root) return
    const observer = new IntersectionObserver(
      (entries) => {
        const current = entries.find((entry) => entry.isIntersecting)
        const id = (current?.target as HTMLElement | undefined)?.dataset.nodeId
        if (id) setSelected(id)
      },
      { root, rootMargin: '0px 0px -75% 0px' },
    )
    root
      .querySelectorAll('[data-node-id]')
      .forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [layoutVersion])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = viewport.current
      if (!root) return

      root
        .querySelector<HTMLElement>('[data-reading-anchor="true"]')
        ?.scrollIntoView({ block: 'center' })

      setAnnotations((current) =>
        current.map((annotation) => {
          const elements = Array.from(
            root.querySelectorAll<HTMLElement>('[data-annotation-id]'),
          ).filter((element) => element.dataset.annotationId === annotation.id)
          if (elements.length === 0) return annotation

          const rectangles = Array.from(elements).flatMap((element) => {
            const page = element.closest<HTMLElement>('.srt-page')
            if (!page) return []
            const pageRect = page.getBoundingClientRect()
            const pageNumber = Number(page.dataset.page)
            return Array.from(element.getClientRects()).map((rectangle) => ({
              page: pageNumber,
              x: rectangle.left - pageRect.left,
              y: rectangle.top - pageRect.top,
              width: rectangle.width,
              height: rectangle.height,
            }))
          })

          return cacheAnnotationGeometry(annotation, layoutVersion, rectangles)
        }),
      )
    })

    return () => cancelAnimationFrame(frame)
  }, [layoutVersion])

  const dimensions = `${profile.dimensions.width} × ${profile.dimensions.height ?? 'continuous'} ${profile.dimensions.unit}`
  const margins = `${profile.margins.top} ${profile.margins.right} ${profile.margins.bottom} ${profile.margins.left} ${profile.margins.unit}`

  const renderFragments = (fragments: PaginationFragment[]) =>
    fragments.map((fragment) => {
      const node = nodes.get(fragment.canonicalId)
      if (!node || node.type === 'caption') return null
      const plan = pagination.nodes.find(
        (candidate) => candidate.canonicalId === fragment.canonicalId,
      )
      const captionFragment =
        node.type === 'figure'
          ? pagination.nodes.find(
              (candidate) =>
                candidate.canonicalId === node.relationships.caption,
            )?.fragments[0]
          : undefined
      return (
        <PaperNode
          key={fragment.id}
          node={node}
          captions={captions}
          target={profileId}
          fragment={fragment}
          fragmentCount={plan?.fragments.length ?? 1}
          captionFragment={captionFragment}
          annotations={resolvedAnnotations}
          visual={previewVisuals.get(node.id)}
          reconstructionProvided={Boolean(reconstruction)}
        />
      )
    })

  return (
    <section className="srt-studio" aria-label="Paper preview">
      <header className="srt-toolbar">
        <div>
          <span className="srt-kicker">Preview</span>
          <strong>
            {reconstruction
              ? 'Continuous source review; profile downloads are validated separately.'
              : profile.note}
          </strong>
        </div>
        <div className="srt-profiles" aria-label="Target profile">
          {availableProfileIds.map((key) => (
            <button
              key={key}
              type="button"
              className={profileId === key ? 'active' : ''}
              aria-pressed={profileId === key}
              onClick={() => switchProfile(key)}
            >
              {getTargetProfile(key).label}
            </button>
          ))}
        </div>
        {profile.orientation.supported.length > 1 && (
          <div className="srt-profiles" aria-label="Orientation">
            {profile.orientation.supported.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={orientation === candidate}
                onClick={() => switchOrientation(candidate)}
              >
                {candidate === 'portrait' ? 'Portrait' : 'Landscape'}
              </button>
            ))}
          </div>
        )}
        <div className="srt-reflow-controls" aria-label="Reader simulations">
          <button
            type="button"
            aria-pressed={widthScale !== 1}
            onClick={toggleWidth}
          >
            Simulate narrow reader
          </button>
          <button
            type="button"
            aria-pressed={fontScale !== 1}
            onClick={toggleFont}
          >
            Simulate larger reader text
          </button>
        </div>
      </header>

      <div className="srt-stage">
        <div ref={viewport} className="srt-viewport">
          <div
            className="srt-paper"
            data-target-profile={profile.id}
            data-orientation={orientation}
            data-columns={profile.columns.count}
            data-finite-height={profile.finiteHeight}
            data-flow-mode={policy.flowMode}
            data-interaction={profile.interactionMode}
            data-page-count={pagination.finalPageCount ?? 'continuous'}
            data-page-count-status={pagination.pageCountStatus}
            data-current-region-stable={
              pagination.currentRegionStability.stable ?? 'not-compared'
            }
            data-current-region-stability={
              pagination.currentRegionStability.status
            }
            data-layout-version={layoutVersion}
            data-width-scale={widthScale}
            data-font-scale={fontScale}
            data-reading-anchor-node={readingAnchor?.nodeId ?? 'unavailable'}
            data-reading-anchor-status={
              readingResolution?.status ?? 'unavailable'
            }
            style={paperStyle}
          >
            {pagination.pages.map((page) => {
              const hasSpanningContent = page.spanningFragments.length > 0
              return (
                <article
                  key={page.number}
                  className="srt-page"
                  data-page={page.number}
                  data-continuous={pagination.mode === 'continuous'}
                >
                  {page.number === 1 && (
                    <DocumentHeader
                      paper={paper}
                      compact={orientation === 'landscape'}
                    />
                  )}
                  <div
                    className="srt-page-regions"
                    data-spanning={hasSpanningContent}
                  >
                    {hasSpanningContent ? (
                      <div className="srt-page-region" data-region="0">
                        {renderFragments(page.spanningFragments)}
                      </div>
                    ) : (
                      page.regions.map((region) => (
                        <div
                          key={region.index}
                          className="srt-page-region"
                          data-region={region.index}
                        >
                          {renderFragments(region.fragments)}
                        </div>
                      ))
                    )}
                  </div>
                  {pagination.mode === 'finite' && (
                    <span className="srt-page-number" aria-hidden="true">
                      {page.number} / {pagination.finalPageCount}
                    </span>
                  )}
                </article>
              )
            })}
          </div>
        </div>
        <aside className="srt-inspector">
          <span className="srt-kicker">Selected section</span>
          <code>{selectedNode.id}</code>
          <dl>
            <div>
              <dt>Type</dt>
              <dd>{selectedNode.type}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{selectedNode.source}</dd>
            </div>
            <div>
              <dt>Profile</dt>
              <dd>{profile.label}</dd>
            </div>
            <div>
              <dt>Dimensions</dt>
              <dd>{dimensions}</dd>
            </div>
            <div>
              <dt>Orientation</dt>
              <dd>
                {orientation} · {profile.orientation.control}
              </dd>
            </div>
            <div>
              <dt>Margins</dt>
              <dd>{margins}</dd>
            </div>
            <div>
              <dt>Typography</dt>
              <dd>
                {profile.typography.bodySizeCssPx}px /{' '}
                {profile.typography.lineHeight}
              </dd>
            </div>
            <div>
              <dt>Columns</dt>
              <dd>{profile.columns.count}</dd>
            </div>
            <div>
              <dt>Pages</dt>
              <dd>{pagination.finalPageCount ?? 'continuous'}</dd>
            </div>
            <div>
              <dt>Current region</dt>
              <dd>
                {pagination.currentRegionStability.status === 'not-compared'
                  ? 'baseline captured'
                  : `${pagination.currentRegionStability.stableFragmentCount} / ${pagination.currentRegionStability.comparedFragmentCount} stable · ${pagination.currentRegionStability.status}`}
              </dd>
            </div>
            <div>
              <dt>Reading anchor</dt>
              <dd
                data-reading-anchor-resolution={
                  readingResolution?.status ?? 'unavailable'
                }
              >
                {readingAnchor && readingResolution
                  ? `${readingAnchor.nodeId} · ${readingAnchor.position.start}–${readingAnchor.position.end} · ${readingResolution.status}`
                  : 'No semantic text anchor available'}
              </dd>
            </div>
            <div>
              <dt>Reflow</dt>
              <dd>
                {Math.round(widthScale * 100)}% width ·{' '}
                {Math.round(fontScale * 100)}% type
              </dd>
            </div>
            <div>
              <dt>Policy</dt>
              <dd>
                {policy.id} · {policy.version}
              </dd>
            </div>
            <div>
              <dt>Keep / split</dt>
              <dd>
                {selectedPagination?.policy.keep} /{' '}
                {selectedPagination?.policy.fragmentation}
              </dd>
            </div>
            <div>
              <dt>Placement</dt>
              <dd>{selectedPagination?.decision.outcome}</dd>
            </div>
            <div>
              <dt>Variant</dt>
              <dd>{selectedComposition.chosenVariant}</dd>
            </div>
            {selectedComposition.fallback && (
              <div>
                <dt>Fallback</dt>
                <dd>
                  {selectedComposition.fallback.fromVariant} →{' '}
                  {selectedComposition.chosenVariant}
                </dd>
              </div>
            )}
            {selectedPagination?.fallback && (
              <div>
                <dt>Page fallback</dt>
                <dd>{selectedPagination.fallback.reason}</dd>
              </div>
            )}
          </dl>
          <section className="srt-annotations" aria-label="Annotations">
            <span className="srt-kicker">Annotations</span>
            <ol>
              {annotationResolutions.length === 0 && (
                <li>No text annotations available for this paper.</li>
              )}
              {annotationResolutions.map(({ annotation, resolution }) => {
                const cache = annotation.geometryCache.find(
                  (entry) => entry.layoutVersion === layoutVersion,
                )
                return (
                  <li
                    key={annotation.id}
                    data-annotation-summary={annotation.id}
                    data-resolution-status={resolution.status}
                    data-anchor-node-id={resolution.nodeId}
                    data-anchor-start={
                      resolution.status === 'resolved' ? resolution.start : ''
                    }
                    data-anchor-end={
                      resolution.status === 'resolved' ? resolution.end : ''
                    }
                    data-geometry-layout-version={cache?.layoutVersion ?? ''}
                    data-geometry-rect-count={cache?.rectangles.length ?? 0}
                  >
                    <strong>
                      {annotation.kind} · {resolution.status}
                    </strong>
                    <q>{annotation.target.quote.exact}</q>
                    <small>
                      {annotation.target.nodeId} ·{' '}
                      {annotation.target.position.start}–
                      {annotation.target.position.end} ·{' '}
                      {cache?.rectangles.length ?? 0} cached rects
                    </small>
                    {annotation.kind === 'note' && (
                      <p id={`${annotation.id}-body`}>{annotation.body}</p>
                    )}
                    {resolution.status !== 'resolved' && (
                      <p role="status">
                        {resolution.status === 'ambiguous'
                          ? `${resolution.reason} ${resolution.candidates.length} candidates require explicit user choice.`
                          : `Annotation unresolved: ${resolution.reason}.`}
                      </p>
                    )}
                  </li>
                )
              })}
            </ol>
          </section>
          <a href={`/research/${paper.id}/manifest.json`}>View layout data →</a>
        </aside>
      </div>
    </section>
  )
}
