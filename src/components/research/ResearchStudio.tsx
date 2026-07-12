import { useEffect, useRef, useState } from 'react'
import type { ResearchNode, ResearchPaper } from '@/research/schema'

const profiles = {
  mobile: { label: 'Mobile', note: 'Continuous · 390 CSS px', width: 390, height: undefined },
  paperProMove: { label: 'Pro Move', note: '7.3″ · 954 × 1696 · 264 PPI', width: 318, height: 565 },
  paperPro: { label: 'Paper Pro', note: '11.8″ · 1620 × 2160 · 229 PPI', width: 540, height: 720 },
  print: { label: 'A4', note: '210 × 297 mm · paged', width: 794, height: 1123 },
} as const

type Profile = keyof typeof profiles

function PaperNode({ node }: { node: ResearchNode }) {
  if (node.type === 'heading') {
    return <h2 data-node-id={node.id}>{node.text}</h2>
  }
  if (node.type === 'quote') {
    return <blockquote data-node-id={node.id}>{node.text}</blockquote>
  }
  if (node.type === 'figure') {
    return (
      <figure data-node-id={node.id}>
        <div className="srt-pipeline" aria-label="Semantic composition pipeline">
          <span>semantic graph</span><i>+</i><span>target policy</span><i>→</i><span>rendition</span>
        </div>
        <figcaption id={node.relationships.caption}><b>{node.title}.</b> {node.caption}</figcaption>
      </figure>
    )
  }
  return <p data-node-id={node.id}>{node.text}</p>
}

export default function ResearchStudio({ paper }: { paper: ResearchPaper }) {
  const [profile, setProfile] = useState<Profile>('paperPro')
  const [selected, setSelected] = useState(paper.nodes[0].id)
  const viewport = useRef<HTMLDivElement>(null)

  const switchProfile = (next: Profile) => {
    const visible = viewport.current?.querySelector('[data-node-id]') as HTMLElement | null
    const anchor = visible?.dataset.nodeId ?? selected
    setProfile(next)
    requestAnimationFrame(() => {
      viewport.current?.querySelector(`[data-node-id="${anchor}"]`)?.scrollIntoView({ block: 'start' })
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
    root.querySelectorAll('[data-node-id]').forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [profile])

  const selectedNode = paper.nodes.find((node) => node.id === selected) ?? paper.nodes[0]

  return (
    <section className="srt-studio" aria-label="Composition studio">
      <header className="srt-toolbar">
        <div>
          <span className="srt-kicker">Live composition</span>
          <strong>{profiles[profile].note}</strong>
        </div>
        <div className="srt-profiles" aria-label="Target profile">
          {(Object.keys(profiles) as Profile[]).map((key) => (
            <button key={key} className={profile === key ? 'active' : ''} onClick={() => switchProfile(key)}>
              {profiles[key].label}
            </button>
          ))}
        </div>
      </header>

      <div className="srt-stage">
        <div ref={viewport} className={`srt-viewport profile-${profile}`}>
          <article
            className="srt-paper"
            style={{
              maxWidth: profiles[profile].width,
              minHeight: profiles[profile].height,
            }}
          >
            <header>
              <small>{paper.status} paper · v{paper.version}</small>
              <h1>{paper.title}</h1>
              <p className="srt-subtitle">{paper.subtitle}</p>
              <p className="srt-authors">{paper.authors.join(', ')} · updated {paper.updated}</p>
              <p className="srt-abstract"><b>Abstract.</b> {paper.abstract}</p>
            </header>
            {paper.nodes.map((node) => <PaperNode key={node.id} node={node} />)}
          </article>
        </div>
        <aside className="srt-inspector">
          <span className="srt-kicker">Current semantic anchor</span>
          <code>{selectedNode.id}</code>
          <dl>
            <div><dt>Type</dt><dd>{selectedNode.type}</dd></div>
            <div><dt>Source</dt><dd>{selectedNode.source}</dd></div>
            <div><dt>Profile</dt><dd>{profiles[profile].label}</dd></div>
            <div><dt>Policy</dt><dd>{profile === 'print' ? 'paged / 2-column' : 'reflow / 1-column'}</dd></div>
          </dl>
          <a href={`/research/${paper.id}/manifest.json`}>Open layout manifest →</a>
        </aside>
      </div>
    </section>
  )
}
