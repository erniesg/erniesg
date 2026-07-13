import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  getCompositionPolicy,
  resolveNodeComposition,
} from '@/research/composition'
import {
  measureCurrentRegionStability,
  paginateResearchPaper,
  type PaginationFragment,
  type PaginationResult,
} from '@/research/pagination'
import type { ResearchNode, ResearchPaper } from '@/research/schema'
import {
  getPreviewMetrics,
  getTargetProfile,
  TARGET_PROFILE_IDS,
  type TargetProfileId,
} from '@/research/targets'

type CaptionNode = Extract<ResearchNode, { type: 'caption' }>

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
}: {
  node: ResearchNode
  captions: Map<string, CaptionNode>
  target: TargetProfileId
  fragment: PaginationFragment
  fragmentCount: number
  captionFragment?: PaginationFragment
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
      {node.text.slice(range.start, range.end)}
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

export default function ResearchStudio({ paper }: { paper: ResearchPaper }) {
  const [profileId, setProfileId] = useState<TargetProfileId>('paperPro')
  const [selected, setSelected] = useState(paper.nodes[0].id)
  const viewport = useRef<HTMLDivElement>(null)
  const previousPagination = useRef<PaginationResult | null>(null)
  const stabilityAnchor = useRef(paper.nodes[0].id)
  const basePagination = useMemo(
    () => paginateResearchPaper(paper, profileId),
    [paper, profileId],
  )
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
    const anchor = selected
    stabilityAnchor.current = anchor
    setProfileId(next)
    requestAnimationFrame(() => {
      viewport.current
        ?.querySelector(`[data-node-id="${anchor}"]`)
        ?.scrollIntoView({ block: 'start' })
    })
  }

  useEffect(() => {
    previousPagination.current = basePagination
  }, [basePagination])

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
  }, [profileId])

  const selectedNode =
    paper.nodes.find((node) => node.id === selected) ?? paper.nodes[0]
  const selectedPagination = pagination.nodes.find(
    (node) => node.canonicalId === selectedNode.id,
  )
  const profile = getTargetProfile(profileId)
  const policy = getCompositionPolicy(profileId)
  const selectedComposition = resolveNodeComposition(profileId, selectedNode)
  const preview = getPreviewMetrics(profile)
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
    '--srt-margin-right': `${preview.marginRightCssPx}px`,
    '--srt-margin-bottom': `${preview.marginBottomCssPx}px`,
    '--srt-margin-left': `${preview.marginLeftCssPx}px`,
    '--srt-font-family': profile.typography.fontFamily,
    '--srt-body-size': `${profile.typography.bodySizeCssPx}px`,
    '--srt-line-height': profile.typography.lineHeight,
    '--srt-title-size': `${profile.typography.titleSizeCssPx}px`,
    '--srt-heading-size': `${profile.typography.headingSizeCssPx}px`,
    '--srt-quote-size': `${profile.typography.quoteSizeCssPx}px`,
    '--srt-column-count': profile.columns.count,
    '--srt-column-gap': `${profile.columns.gapCssPx}px`,
  } as CSSProperties

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
          <a href={`/research/${paper.id}/manifest.json`}>View layout data →</a>
        </aside>
      </div>
    </section>
  )
}
