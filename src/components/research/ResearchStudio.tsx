import {
  createElement,
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
  inspectEpub,
  publicationTextSegments,
  stablePublicationId,
  type EpubExport,
} from '../../research/epub'
import type {
  DocumentReconstruction,
  PublicationAsset,
  PublicationVisualRelationship,
} from '../../research/import-types'
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
import type { ResearchNode, ResearchPaper } from '../../research/schema'
import {
  getPreviewMetrics,
  getTargetProfile,
  TARGET_PROFILE_IDS,
  type TargetProfileId,
} from '../../research/targets'

type CaptionNode = Extract<ResearchNode, { type: 'caption' }>
type ResolvedTextAnnotation = {
  annotation: TextAnnotation
  resolution: Extract<TextAnchorResolution, { status: 'resolved' }>
}

function AnnotatedText({
  text,
  range,
  annotations,
}: {
  text: string
  range: { start: number; end: number }
  annotations: ResolvedTextAnnotation[]
}) {
  const relevant = annotations.filter(
    ({ resolution }) =>
      resolution.start < range.end && resolution.end > range.start,
  )
  if (relevant.length === 0) return text.slice(range.start, range.end)

  const boundaries = new Set([range.start, range.end])
  for (const { resolution } of relevant) {
    boundaries.add(Math.max(range.start, resolution.start))
    boundaries.add(Math.min(range.end, resolution.end))
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
}: {
  node: ResearchNode
  captions: Map<string, CaptionNode>
  target: TargetProfileId
  fragment: PaginationFragment
  fragmentCount: number
  captionFragment?: PaginationFragment
  annotations: ResolvedTextAnnotation[]
}) {
  const composition = resolveNodeComposition(target, node)
  const data = fragmentData(fragment, fragmentCount)

  if (node.type === 'heading') {
    return (
      <h2 {...data} data-variant={composition.chosenVariant}>
        {node.text}
      </h2>
    )
  }
  if (node.type === 'quote') {
    return (
      <blockquote {...data} data-variant={composition.chosenVariant}>
        {node.text}
      </blockquote>
    )
  }
  if (node.type === 'caption') return null

  if (node.type === 'footnote') {
    return (
      <aside
        {...data}
        id={node.id}
        role="doc-footnote"
        data-variant={composition.chosenVariant}
      >
        <sup>{node.label}</sup> {node.text}
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
        <div
          className="srt-pipeline"
          aria-label="Semantic composition pipeline"
        >
          <span>semantic graph</span>
          <i>+</i>
          <span>target policy</span>
          <i>→</i>
          <span>rendition</span>
        </div>
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
      />
    </p>
  )
}

function DocumentHeader({ paper }: { paper: ResearchPaper }) {
  return (
    <header className="srt-document-header">
      <small>
        {paper.status} paper · v{paper.version}
      </small>
      <h1>{paper.title}</h1>
      <p className="srt-subtitle">{paper.subtitle}</p>
      <p className="srt-authors">
        {paper.authors.join(', ')} · updated {paper.updated}
      </p>
      <p className="srt-abstract">
        <b>Abstract.</b> {paper.abstract}
      </p>
    </header>
  )
}

type InlineNode = Extract<
  ResearchNode,
  { type: 'heading' | 'paragraph' | 'quote' }
>

function SemanticText({ node }: { node: InlineNode }) {
  return publicationTextSegments(
    node.text,
    node.noteReferences,
    node.inlineRuns,
  ).map((segment) => {
    let content: ReactNode = segment.text
    if (segment.italic) content = <em>{content}</em>
    if (segment.bold) content = <strong>{content}</strong>
    if (segment.reference) {
      content = (
        <a
          id={stablePublicationId(segment.reference.id)}
          href={`#${stablePublicationId(segment.reference.target)}`}
          role="doc-noteref"
        >
          {content}
        </a>
      )
    } else if (segment.href) {
      content = <a href={segment.href}>{content}</a>
    }
    return (
      <Fragment key={`${segment.start}-${segment.end}`}>{content}</Fragment>
    )
  })
}

type CheckedPreviewAsset = Pick<
  PublicationAsset,
  'id' | 'href' | 'mediaType' | 'bytes'
> & {
  sourceAssetId: string
}

function checkedPreviewAssets(
  reconstruction: DocumentReconstruction,
  previewEpub?: EpubExport,
) {
  if (!previewEpub) {
    return new Map(
      reconstruction.assets.map((asset) => [
        asset.id,
        { ...asset, sourceAssetId: asset.id } satisfies CheckedPreviewAsset,
      ]),
    )
  }

  const expectedProfile = getTargetProfile('mobile')
  const { files, manifest } = inspectEpub(previewEpub.bytes, expectedProfile)
  const receipt = manifest as typeof manifest & {
    sourcePdfSha256?: string
    sourceDocxSha256?: string
    assets?: Array<{
      id?: string
      href?: string
      mediaType?: string
      sourceAssetId?: string
    }>
  }
  const receiptSourceHash =
    reconstruction.source.format === 'docx'
      ? receipt.sourceDocxSha256
      : receipt.sourcePdfSha256
  if (receiptSourceHash !== reconstruction.source.sha256) {
    throw new Error('Preview EPUB does not match the active reconstruction')
  }

  const sourceAssets = new Map(
    reconstruction.assets.map((asset) => [asset.id, asset]),
  )
  const checked = new Map<string, CheckedPreviewAsset>()
  for (const packaged of receipt.assets ?? []) {
    if (!packaged.sourceAssetId || !packaged.href || !packaged.id) continue
    const source = sourceAssets.get(packaged.sourceAssetId)
    const bytes = files[`EPUB/${packaged.href}`]
    if (!source || !bytes || packaged.mediaType !== source.mediaType) continue
    checked.set(packaged.sourceAssetId, {
      id: packaged.id,
      href: packaged.href,
      mediaType: source.mediaType,
      bytes,
      sourceAssetId: packaged.sourceAssetId,
    })
  }
  return checked
}

function usePreviewAssetUrls(assets: Map<string, CheckedPreviewAsset>) {
  const [urlState, setUrlState] = useState<{
    assets: Map<string, CheckedPreviewAsset>
    urls: Map<string, string>
  }>(() => ({ assets, urls: new Map() }))

  useEffect(() => {
    const next = new Map<string, string>()
    if (typeof URL.createObjectURL !== 'function') {
      setUrlState({ assets, urls: next })
      return
    }
    for (const [sourceAssetId, asset] of assets) {
      if (
        asset.mediaType !== 'image/png' &&
        asset.mediaType !== 'image/jpeg' &&
        asset.mediaType !== 'image/gif' &&
        asset.mediaType !== 'image/svg+xml'
      ) {
        continue
      }
      next.set(
        sourceAssetId,
        URL.createObjectURL(
          new Blob([asset.bytes as BlobPart], { type: asset.mediaType }),
        ),
      )
    }
    setUrlState({ assets, urls: next })
    return () => {
      for (const url of next.values()) URL.revokeObjectURL(url)
    }
  }, [assets])

  return urlState.assets === assets ? urlState.urls : new Map<string, string>()
}

function SemanticTable({
  node,
}: {
  node: Extract<ResearchNode, { type: 'figure' }>
}) {
  if (node.objectType !== 'table' || !node.table?.rows.length) return null
  return (
    <table data-semantic-table="true">
      <tbody>
        {node.table.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.cells.map((cell, cellIndex) => {
              const Cell = cell.header ? 'th' : 'td'
              return (
                <Cell
                  key={cellIndex}
                  colSpan={cell.columnSpan}
                  rowSpan={cell.rowSpan}
                  {...(cell.header ? { scope: 'col' as const } : {})}
                >
                  {cell.text}
                </Cell>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function UnresolvedVisual({ assetId }: { assetId?: string }) {
  return (
    <p className="srt-visual-unresolved" role="status" data-asset-id={assetId}>
      Source visual unavailable in this checked preview.
    </p>
  )
}

function ImportedFigure({
  node,
  caption,
  relationship,
  assets,
  urls,
}: {
  node: Extract<ResearchNode, { type: 'figure' }>
  caption?: CaptionNode
  relationship?: PublicationVisualRelationship
  assets: Map<string, CheckedPreviewAsset>
  urls: Map<string, string>
}) {
  const captionId = stablePublicationId(node.relationships.caption)
  const matched = relationship?.status === 'matched'
  const assetIds = matched ? relationship.assetIds : []
  return (
    <figure
      id={stablePublicationId(node.id)}
      data-node-id={node.id}
      data-canonical-id={stablePublicationId(node.id)}
      data-caption-id={captionId}
      data-object-type={relationship?.kind ?? node.objectType ?? 'figure'}
      data-relationship-id={relationship?.id}
      data-source-object-ids={relationship?.sourceObjectIds.join(' ')}
      role="group"
    >
      {assetIds.length === 0 && <UnresolvedVisual />}
      {assetIds.map((assetId, occurrence) => {
        const asset = assets.get(assetId)
        if (!asset) {
          return (
            <UnresolvedVisual
              key={`${assetId}-${occurrence}`}
              assetId={assetId}
            />
          )
        }
        if (asset.mediaType === 'application/xhtml+xml') {
          return node.objectType === 'table' && node.table?.rows.length ? (
            <div
              key={`${assetId}-${occurrence}`}
              className="srt-semantic-table"
              data-asset-id={asset.id}
              data-asset-source-id={asset.sourceAssetId}
              data-asset-occurrence={occurrence}
            >
              <SemanticTable node={node} />
            </div>
          ) : (
            <UnresolvedVisual
              key={`${assetId}-${occurrence}`}
              assetId={assetId}
            />
          )
        }
        const url = urls.get(assetId)
        return url ? (
          <img
            key={`${assetId}-${occurrence}`}
            src={url}
            alt={relationship?.altText ?? node.title}
            data-alt-source={relationship?.altTextSource}
            data-asset-id={asset.id}
            data-asset-source-id={asset.sourceAssetId}
            data-asset-occurrence={occurrence}
          />
        ) : (
          <span
            key={`${assetId}-${occurrence}`}
            className="srt-visual-pending"
            role="status"
            data-asset-id={asset.id}
            data-asset-source-id={asset.sourceAssetId}
            data-asset-occurrence={occurrence}
          >
            Preparing local visual…
          </span>
        )
      })}
      {caption && (
        <figcaption
          id={captionId}
          data-node-id={caption.id}
          data-canonical-id={captionId}
          data-relationship-id={relationship?.id}
        >
          {caption.text}
        </figcaption>
      )}
    </figure>
  )
}

function ImportedNode({
  node,
  captions,
  relationships,
  assets,
  urls,
}: {
  node: ResearchNode
  captions: Map<string, CaptionNode>
  relationships: Map<string, PublicationVisualRelationship>
  assets: Map<string, CheckedPreviewAsset>
  urls: Map<string, string>
}) {
  const id = stablePublicationId(node.id)
  const data = { 'data-node-id': node.id, 'data-canonical-id': id }
  if (node.type === 'heading') {
    return createElement(
      `h${Math.min(4, node.level + 1)}`,
      { ...data, id },
      <SemanticText node={node} />,
    )
  }
  if (node.type === 'paragraph') {
    return (
      <p {...data} id={id}>
        <SemanticText node={node} />
      </p>
    )
  }
  if (node.type === 'quote') {
    return (
      <blockquote {...data} id={id}>
        <p>
          <SemanticText node={node} />
        </p>
      </blockquote>
    )
  }
  if (node.type === 'footnote') {
    return (
      <aside
        {...data}
        id={id}
        role={`doc-${node.kind}`}
        data-note-kind={node.kind}
        className="publication-note"
      >
        <span className="note-label">{node.label}</span> {node.text}{' '}
        {node.relationships.backlinks.map((backlink, index) => (
          <a
            key={backlink}
            href={`#${stablePublicationId(backlink)}`}
            className="note-backlink"
            aria-label={`Back to reference ${index + 1}`}
          >
            ↩
          </a>
        ))}
      </aside>
    )
  }
  if (node.type === 'figure') {
    return (
      <ImportedFigure
        node={node}
        caption={captions.get(node.relationships.caption)}
        relationship={relationships.get(node.id)}
        assets={assets}
        urls={urls}
      />
    )
  }
  return (
    <aside {...data} id={id} className="orphan-caption">
      {node.text}
    </aside>
  )
}

type ListParagraph = Extract<ResearchNode, { type: 'paragraph' }> & {
  list: NonNullable<Extract<ResearchNode, { type: 'paragraph' }>['list']>
}

function isListParagraph(node: ResearchNode): node is ListParagraph {
  return node.type === 'paragraph' && node.list !== undefined
}

type ImportedListGroup = {
  level: number
  ordered: boolean
  numberingId: string
  items: Array<{
    node: ListParagraph
    children: ImportedListGroup[]
  }>
}

function buildImportedList(
  nodes: ResearchNode[],
  start: number,
): { group: ImportedListGroup; next: number } | null {
  const first = nodes[start]
  if (!first || !isListParagraph(first)) return null
  const level = first.list.level
  const ordered = first.list.ordered
  const numberingId = first.list.numberingId
  const items: ImportedListGroup['items'] = []
  let index = start

  while (index < nodes.length) {
    const node = nodes[index]
    if (!isListParagraph(node) || node.list.level < level) break
    if (
      node.list.level === level &&
      (node.list.ordered !== ordered || node.list.numberingId !== numberingId)
    ) {
      break
    }
    if (node.list.level > level) {
      const child = buildImportedList(nodes, index)
      const previous = items.at(-1)
      if (!previous || !child || child.next === index) break
      previous.children.push(child.group)
      index = child.next
      continue
    }
    items.push({ node, children: [] })
    index += 1
  }

  return {
    group: { level, ordered, numberingId, items },
    next: index,
  }
}

function ImportedList({ group }: { group: ImportedListGroup }) {
  const List = group.ordered ? 'ol' : 'ul'
  return (
    <List data-list-level={group.level} data-numbering-id={group.numberingId}>
      {group.items.map(({ node, children }) => {
        const id = stablePublicationId(node.id)
        return (
          <li
            key={node.id}
            id={id}
            data-node-id={node.id}
            data-canonical-id={id}
            data-list-level={node.list.level}
            data-numbering-id={node.list.numberingId}
          >
            <SemanticText node={node} />
            {children.map((child, index) => (
              <ImportedList key={`${node.id}-nested-${index}`} group={child} />
            ))}
          </li>
        )
      })}
    </List>
  )
}

function ImportedFlow({
  paper,
  relationships,
  assets,
  urls,
}: {
  paper: ResearchPaper
  relationships: Map<string, PublicationVisualRelationship>
  assets: Map<string, CheckedPreviewAsset>
  urls: Map<string, string>
}) {
  const captions = new Map(
    paper.nodes
      .filter((node): node is CaptionNode => node.type === 'caption')
      .map((node) => [node.id, node]),
  )
  const associatedCaptions = new Set(
    paper.nodes
      .filter(
        (node): node is Extract<ResearchNode, { type: 'figure' }> =>
          node.type === 'figure',
      )
      .map((node) => node.relationships.caption),
  )
  const content: ReactNode[] = []
  let index = 0
  while (index < paper.nodes.length) {
    const node = paper.nodes[index]
    if (isListParagraph(node)) {
      const list = buildImportedList(paper.nodes, index)
      if (!list) {
        index += 1
        continue
      }
      content.push(<ImportedList key={`list-${index}`} group={list.group} />)
      index = list.next
      continue
    }
    if (node.type === 'caption' && associatedCaptions.has(node.id)) {
      index += 1
      continue
    }
    content.push(
      <ImportedNode
        key={node.id}
        node={node}
        captions={captions}
        relationships={relationships}
        assets={assets}
        urls={urls}
      />,
    )
    index += 1
  }
  return content
}

function ImportedResearchStudio({
  reconstruction,
  previewEpub,
}: {
  reconstruction: DocumentReconstruction
  previewEpub?: EpubExport
}) {
  const paper = reconstruction.paper
  const profile = getTargetProfile('mobile')
  const preview = getPreviewMetrics(profile)
  const [widthScale, setWidthScale] = useState(1)
  const [fontScale, setFontScale] = useState(1)
  const assets = useMemo(
    () => checkedPreviewAssets(reconstruction, previewEpub),
    [previewEpub, reconstruction],
  )
  const urls = usePreviewAssetUrls(assets)
  const relationships = useMemo(
    () =>
      new Map(
        reconstruction.visualRelationships
          .filter(
            (relationship) =>
              relationship.status === 'matched' && relationship.canonicalNodeId,
          )
          .map((relationship) => [relationship.canonicalNodeId!, relationship]),
      ),
    [reconstruction],
  )
  const paperStyle = {
    width: preview.widthCssPx * widthScale,
    maxWidth: preview.widthCssPx * widthScale,
    '--srt-page-height': 'auto',
    '--srt-header-height': 'auto',
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
    '--srt-column-count': 1,
    '--srt-column-gap': '0px',
  } as CSSProperties

  return (
    <section className="srt-studio" aria-label="Imported publication preview">
      <header className="srt-toolbar">
        <div>
          <span className="srt-kicker">Source review</span>
          <strong>Continuous reflow from the checked Mobile EPUB</strong>
        </div>
        <div className="srt-profiles" aria-label="Target profile">
          <button
            type="button"
            className="active"
            aria-pressed="true"
            data-profile-id={profile.id}
            data-profile-version={profile.version}
          >
            {profile.label}
          </button>
        </div>
        <div className="srt-reflow-controls" aria-label="Reader controls">
          <button
            type="button"
            aria-pressed={widthScale !== 1}
            onClick={() =>
              setWidthScale((current) => (current === 1 ? 0.86 : 1))
            }
          >
            Narrow width
          </button>
          <button
            type="button"
            aria-pressed={fontScale !== 1}
            onClick={() =>
              setFontScale((current) => (current === 1 ? 1.12 : 1))
            }
          >
            Larger text
          </button>
        </div>
      </header>
      <div className="srt-stage">
        <div className="srt-viewport">
          <div
            className="srt-paper"
            data-target-profile={profile.id}
            data-profile-version={profile.version}
            data-columns="1"
            data-finite-height="false"
            data-flow-mode="canonical-reading-order"
            data-interaction={profile.interactionMode}
            data-page-count="continuous"
            data-page-count-status="continuous"
            data-source-review="true"
            data-source-sha256={reconstruction.source.sha256}
            data-preview-status={previewEpub ? 'checked' : 'awaiting-epub'}
            data-epub-sha256={previewEpub?.sha256}
            data-width-scale={widthScale}
            data-font-scale={fontScale}
            style={paperStyle}
          >
            <article className="srt-page" data-page="1" data-continuous="true">
              <DocumentHeader paper={paper} />
              <div className="srt-page-regions" data-spanning="false">
                <div className="srt-page-region" data-region="0">
                  <ImportedFlow
                    paper={paper}
                    relationships={relationships}
                    assets={assets}
                    urls={urls}
                  />
                </div>
              </div>
            </article>
          </div>
        </div>
        <aside className="srt-inspector">
          <span className="srt-kicker">Preview contract</span>
          <code>{reconstruction.source.fileName}</code>
          <dl>
            <div>
              <dt>Profile</dt>
              <dd>{profile.label}</dd>
            </div>
            <div>
              <dt>Flow</dt>
              <dd>Continuous canonical order</dd>
            </div>
            <div>
              <dt>Columns</dt>
              <dd>One semantic stream</dd>
            </div>
            <div>
              <dt>Artifact</dt>
              <dd>{previewEpub ? 'EPUB checked' : 'Validation pending'}</dd>
            </div>
            <div>
              <dt>Reader controls</dt>
              <dd>Width and type are advisory</dd>
            </div>
          </dl>
          <p className="srt-preview-disclaimer">
            This continuous review shows canonical reading order. The optional
            download is validated separately for compatible EPUB readers.
          </p>
        </aside>
      </div>
    </section>
  )
}

function DemoResearchStudio({ paper }: { paper: ResearchPaper }) {
  const [profileId, setProfileId] = useState<TargetProfileId>('paperPro')
  const [widthScale, setWidthScale] = useState(1)
  const [fontScale, setFontScale] = useState(1)
  const [selected, setSelected] = useState(paper.nodes[0].id)
  const [annotations, setAnnotations] = useState<TextAnnotation[]>(() =>
    createDemoAnnotations(paper),
  )
  const viewport = useRef<HTMLDivElement>(null)
  const previousPagination = useRef<PaginationResult | null>(null)
  const readingAnchor = annotations[0]?.target
  const stabilityNodeId = readingAnchor?.nodeId ?? paper.nodes[0].id
  const stabilityAnchor = useRef(stabilityNodeId)
  const basePagination = useMemo(() => {
    const preview = getPreviewMetrics(getTargetProfile(profileId))
    return paginateResearchPaper(paper, profileId, {
      widthCssPx: preview.widthCssPx * widthScale,
      fontScale,
    })
  }, [fontScale, paper, profileId, widthScale])
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
    setProfileId(next)
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
  const profile = getTargetProfile(profileId)
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
        />
      )
    })

  return (
    <section className="srt-studio" aria-label="Paper preview">
      <header className="srt-toolbar">
        <div>
          <span className="srt-kicker">Preview</span>
          <strong>{profile.note}</strong>
        </div>
        <div className="srt-profiles" aria-label="Target profile">
          {TARGET_PROFILE_IDS.map((key) => (
            <button
              key={key}
              className={profileId === key ? 'active' : ''}
              onClick={() => switchProfile(key)}
            >
              {getTargetProfile(key).label}
            </button>
          ))}
        </div>
        <div className="srt-reflow-controls" aria-label="Reflow controls">
          <button
            type="button"
            aria-pressed={widthScale !== 1}
            onClick={toggleWidth}
          >
            Narrow width
          </button>
          <button
            type="button"
            aria-pressed={fontScale !== 1}
            onClick={toggleFont}
          >
            Larger text
          </button>
        </div>
      </header>

      <div className="srt-stage">
        <div ref={viewport} className="srt-viewport">
          <div
            className="srt-paper"
            data-target-profile={profile.id}
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
                  {page.number === 1 && <DocumentHeader paper={paper} />}
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

export default function ResearchStudio({
  paper,
  reconstruction,
  previewEpub,
}: {
  paper?: ResearchPaper
  reconstruction?: DocumentReconstruction
  previewEpub?: EpubExport
}) {
  if (reconstruction) {
    return (
      <ImportedResearchStudio
        reconstruction={reconstruction}
        previewEpub={previewEpub}
      />
    )
  }
  if (!paper) throw new Error('ResearchStudio requires a paper')
  return <DemoResearchStudio paper={paper} />
}
