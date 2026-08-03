import type { PublicationGraph, PublicationNode } from './schema'
import {
  createRendererProbe,
  type RendererMeasurement,
  type RendererProbe,
} from './renderer-probe'
import type { LayoutPlan } from './planner'

export const VIVLIOSTYLE_RENDERER_VERSION = '1.0.0' as const
export const PUBLICATION_PROFILES = [
  'phone-webpub',
  'eink-epub',
  'a5-pdf',
  'a4-pdf',
] as const
export type PublicationProfile = (typeof PUBLICATION_PROFILES)[number]

export type VivliostyleRenderOptions = RendererMeasurement & {
  stylesheet?: string
}

export type VivliostyleRenderResult = {
  rendererId: 'vivliostyle'
  rendererVersion: typeof VIVLIOSTYLE_RENDERER_VERSION
  html: string
  probe: RendererProbe
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function textFor(node: PublicationNode) {
  if ('text' in node) return node.text
  if (node.type === 'code') return node.code
  if (node.type === 'equation') return node.source
  if (node.type === 'figure') return node.title
  return ''
}

function elementFor(node: PublicationNode, anchorId: string) {
  const text = escapeHtml(textFor(node))
  switch (node.type) {
    case 'heading':
      return `<h${node.level} id="${anchorId}" data-canonical-id="${node.id}">${text}</h${node.level}>`
    case 'paragraph':
      return `<p id="${anchorId}" data-canonical-id="${node.id}">${text}</p>`
    case 'quote':
      return `<blockquote id="${anchorId}" data-canonical-id="${node.id}">${text}</blockquote>`
    case 'code':
      return `<pre id="${anchorId}" data-canonical-id="${node.id}"><code>${text}</code></pre>`
    case 'equation':
      return `<div id="${anchorId}" data-canonical-id="${node.id}" role="math">${text}</div>`
    case 'list':
      return `<ol id="${anchorId}" data-canonical-id="${node.id}"></ol>`
    case 'list-item':
      return `<li id="${anchorId}" data-canonical-id="${node.id}">${text}</li>`
    case 'figure':
      return `<figure id="${anchorId}" data-canonical-id="${node.id}"><figcaption>${text}</figcaption></figure>`
    case 'caption':
      return `<figcaption id="${anchorId}" data-canonical-id="${node.id}">${text}</figcaption>`
    case 'table':
      return `<table id="${anchorId}" data-canonical-id="${node.id}">${node.rows
        .map(
          (row) =>
            `<tr>${row.cells
              .map((cell) => `<td>${escapeHtml(cell.text)}</td>`)
              .join('')}</tr>`,
        )
        .join('')}</table>`
    case 'aside':
      return `<aside id="${anchorId}" data-canonical-id="${node.id}">${text}</aside>`
    case 'note':
      return `<aside id="${anchorId}" data-canonical-id="${node.id}" role="doc-footnote">${text}</aside>`
    case 'reference':
      return `<p id="${anchorId}" data-canonical-id="${node.id}" role="doc-biblioentry">${text}</p>`
    case 'media':
      return `<figure id="${anchorId}" data-canonical-id="${node.id}"><span role="img" aria-label="${escapeHtml(node.accessibility.alternativeText ?? '')}"></span></figure>`
  }
}

/** Convert a renderer-neutral plan into semantic HTML.  This is deliberately
 * not a geometry API: Vivliostyle may measure the HTML, but measurements are
 * returned only in the probe. */
export function layoutPlanToSemanticHtml(
  graph: PublicationGraph,
  plan: LayoutPlan,
  stylesheet = 'publication.css',
) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const body = plan.fragments
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((fragment) => {
      const node = nodes.get(fragment.nodeId)
      return node ? elementFor(node, fragment.outputAnchor.id) : ''
    })
    .join('\n')
  const direction = graph.edition.direction === 'auto' ? 'ltr' : graph.edition.direction
  return `<!doctype html>\n<html lang="${escapeHtml(graph.edition.locale)}" dir="${direction}" data-plan="${escapeHtml(plan.id)}"><head><meta charset="utf-8"><title>${escapeHtml(graph.metadata.title)}</title><link rel="stylesheet" href="${escapeHtml(stylesheet)}"></head><body><main>${body}</main></body></html>\n`
}

export function probeVivliostyleLayout(
  plan: LayoutPlan,
  measurement: RendererMeasurement = {},
) {
  return createRendererProbe(plan, {
    rendererId: 'vivliostyle',
    rendererVersion: VIVLIOSTYLE_RENDERER_VERSION,
    ...measurement,
  })
}

export function renderLayoutPlan(
  graph: PublicationGraph,
  plan: LayoutPlan,
  options: VivliostyleRenderOptions = {},
): VivliostyleRenderResult {
  if (plan.hardViolations.length) {
    throw new Error('Cannot render a layout plan with static hard violations')
  }
  return {
    rendererId: 'vivliostyle',
    rendererVersion: VIVLIOSTYLE_RENDERER_VERSION,
    html: layoutPlanToSemanticHtml(graph, plan, options.stylesheet),
    probe: probeVivliostyleLayout(plan, options),
  }
}

export const renderPlan = renderLayoutPlan
export const renderWithVivliostyle = renderLayoutPlan

/** Adapter shape used by the planner's renderer provider boundary. */
export const vivliostyleRenderer = {
  id: 'vivliostyle' as const,
  version: VIVLIOSTYLE_RENDERER_VERSION,
  probe: probeVivliostyleLayout,
  render: renderLayoutPlan,
}

export const vivliostyleRendererAdapter = vivliostyleRenderer
