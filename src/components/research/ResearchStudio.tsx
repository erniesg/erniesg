import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  getCompositionPolicy,
  resolveNodeComposition,
} from '@/research/composition'
import type { ResearchNode, ResearchPaper } from '@/research/schema'
import {
  getPreviewMetrics,
  getTargetProfile,
  TARGET_PROFILE_IDS,
  type TargetProfileId,
} from '@/research/targets'

type CaptionNode = Extract<ResearchNode, { type: 'caption' }>

function PaperNode({
  node,
  captions,
  target,
}: {
  node: ResearchNode
  captions: Map<string, CaptionNode>
  target: TargetProfileId
}) {
  const composition = resolveNodeComposition(target, node)

  if (node.type === 'heading') {
    return (
      <h2 data-node-id={node.id} data-variant={composition.chosenVariant}>
        {node.text}
      </h2>
    )
  }
  if (node.type === 'quote') {
    return (
      <blockquote
        data-node-id={node.id}
        data-variant={composition.chosenVariant}
      >
        {node.text}
      </blockquote>
    )
  }
  if (node.type === 'caption') {
    return null
  }
  if (node.type === 'figure') {
    const caption = captions.get(node.relationships.caption)
    return (
      <figure data-node-id={node.id} data-variant={composition.chosenVariant}>
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
          id={node.relationships.caption}
          data-node-id={node.relationships.caption}
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
  return (
    <p data-node-id={node.id} data-variant={composition.chosenVariant}>
      {node.text}
    </p>
  )
}

export default function ResearchStudio({ paper }: { paper: ResearchPaper }) {
  const [profileId, setProfileId] = useState<TargetProfileId>('paperPro')
  const [selected, setSelected] = useState(paper.nodes[0].id)
  const viewport = useRef<HTMLDivElement>(null)

  const switchProfile = (next: TargetProfileId) => {
    const visible = viewport.current?.querySelector(
      '[data-node-id]',
    ) as HTMLElement | null
    const anchor = visible?.dataset.nodeId ?? selected
    setProfileId(next)
    requestAnimationFrame(() => {
      viewport.current
        ?.querySelector(`[data-node-id="${anchor}"]`)
        ?.scrollIntoView({ block: 'start' })
    })
  }

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
  const profile = getTargetProfile(profileId)
  const policy = getCompositionPolicy(profileId)
  const selectedComposition = resolveNodeComposition(profileId, selectedNode)
  const preview = getPreviewMetrics(profile)
  const captions = new Map(
    paper.nodes
      .filter((node): node is CaptionNode => node.type === 'caption')
      .map((node) => [node.id, node]),
  )
  const paperStyle = {
    width: '100%',
    maxWidth: preview.widthCssPx,
    minHeight: preview.minHeightCssPx,
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
          <article
            className="srt-paper"
            data-target-profile={profile.id}
            data-columns={profile.columns.count}
            data-finite-height={profile.finiteHeight}
            data-flow-mode={policy.flowMode}
            data-interaction={profile.interactionMode}
            style={paperStyle}
          >
            <header>
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
            {paper.nodes.map((node) => (
              <PaperNode
                key={node.id}
                node={node}
                captions={captions}
                target={profileId}
              />
            ))}
          </article>
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
              <dt>Interaction</dt>
              <dd>{profile.interactionMode}</dd>
            </div>
            <div>
              <dt>Finite height</dt>
              <dd>{profile.finiteHeight ? 'yes' : 'no'}</dd>
            </div>
            <div>
              <dt>Policy</dt>
              <dd>
                {policy.id} · {policy.version}
              </dd>
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
          </dl>
          <a href={`/research/${paper.id}/manifest.json`}>View layout data →</a>
        </aside>
      </div>
    </section>
  )
}
