/**
 * The book's map: every topic, what it needs first, and where the reader
 * stands. One implementation for the local preview and the published site;
 * moved out of `preview.py`, where the state was worked out on the server from
 * `progress.json`. The site keeps progress in the reader's browser and
 * account, so the state is worked out here, from whatever `solved` the host
 * hands over.
 *
 * `topics` are the book manifest's topic entries (`manifest.topic_entries`):
 * id, title, part, partName, agent, requires (titles), requiresIds, unlocks
 * (titles) and the nodes written for each.
 *
 * `drawMap` needs Cytoscape and its dagre layout loaded as globals, which both
 * hosts do from a CDN, and the markup `render.map_markup()` writes.
 */

/** A topic's state: cleared, open (everything it needs is cleared), locked, or empty. */
export function topicStates(topics, solved) {
  const done = new Set(solved)
  const byId = new Map(topics.map((topic) => [topic.id, topic]))
  const memo = new Map()
  const state = (id, seen) => {
    if (!seen.size && memo.has(id)) return memo.get(id)
    const topic = byId.get(id)
    const challenges = topic.nodes.filter((node) => node.kind === 'challenge')
    let result
    if (challenges.length && challenges.every((node) => done.has(node.id))) result = 'cleared'
    else if (!topic.nodes.length) result = 'empty'
    else {
      const parents = (topic.requiresIds || []).filter((p) => byId.has(p) && !seen.has(p))
      const next = new Set([...seen, id])
      result = parents.every((p) => state(p, next) === 'cleared') ? 'open' : 'locked'
    }
    if (!seen.size) memo.set(id, result)
    return result
  }
  return new Map(topics.map((topic) => [topic.id, state(topic.id, new Set())]))
}

/** Cytoscape elements: one node per topic, one edge per requirement. */
export function mapElements(topics, solved) {
  const done = new Set(solved)
  const states = topicStates(topics, solved)
  const known = new Set(topics.map((topic) => topic.id))
  const nodes = topics.map((topic) => {
    const challenges = topic.nodes.filter((node) => node.kind === 'challenge')
    return {
      data: {
        id: topic.id,
        label: topic.title,
        state: states.get(topic.id),
        part: topic.part,
        partName: topic.partName,
        agent: topic.agent,
        solved: challenges.filter((node) => done.has(node.id)).length,
        total: challenges.length,
        requires: topic.requires,
        unlocks: topic.unlocks,
        nodes: topic.nodes.map((node) => ({ ...node, solved: done.has(node.id) })),
      },
    }
  })
  const edges = topics.flatMap((topic) =>
    (topic.requiresIds || [])
      .filter((parent) => known.has(parent))
      .map((parent) => ({ data: { id: `${parent}->${topic.id}`, source: parent, target: topic.id } })),
  )
  return [...nodes, ...edges]
}

export function mapCounts(topics, solved) {
  const states = [...topicStates(topics, solved).values()]
  return {
    topics: topics.length,
    cleared: states.filter((state) => state === 'cleared').length,
    written: topics.filter((topic) => topic.nodes.length).length,
  }
}

// Below this zoom a topic's label is too small to read.
const READABLE_ZOOM = 0.6

const MAP_COLOURS = {
  cleared: { bg: '#dcfce7', line: '#15803d', text: '#14532d' },
  open: { bg: '#e0f2fe', line: '#0369a1', text: '#0c4a6e' },
  locked: { bg: '#f1f1ef', line: '#9ca3af', text: '#4b5563' },
  empty: { bg: '#fafaf8', line: '#d4d4d4', text: '#6b7280' },
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/**
 * Draw the map into `doc`'s map markup. `href(nodeId)` is where a written
 * chapter or challenge lives on this host. Returns the Cytoscape instance, or
 * null when Cytoscape did not load.
 */
export function drawMap(doc, { topics, solved, href, cytoscape = globalThis.cytoscape, dagre = globalThis.cytoscapeDagre }) {
  const container = doc.getElementById('map')
  const detail = doc.getElementById('map-detail')
  if (!container || !detail) return null
  const counts = mapCounts(topics, solved)
  doc.querySelectorAll('[data-map-counts]').forEach((line) => {
    line.textContent = `${counts.topics} topics · ${counts.cleared} cleared · ${counts.written} with content written`
  })
  if (typeof cytoscape !== 'function') {
    detail.innerHTML = '<p class="detail-empty">The map could not load. Check your connection and reload.</p>'
    return null
  }
  if (dagre && !cytoscape.__bookDagre) {
    cytoscape.use(dagre)
    cytoscape.__bookDagre = true
  }

  const cy = cytoscape({
    container,
    elements: mapElements(topics, solved),
    wheelSensitivity: 0.2,
    style: [
      { selector: 'node', style: {
          'background-color': (n) => MAP_COLOURS[n.data('state')].bg,
          'border-color': (n) => MAP_COLOURS[n.data('state')].line,
          'border-width': (n) => (n.data('state') === 'cleared' ? 2.5 : 1.5),
          'border-style': (n) => (n.data('state') === 'empty' ? 'dashed' : 'solid'),
          label: 'data(label)', color: (n) => MAP_COLOURS[n.data('state')].text,
          'font-size': 12, 'font-family': 'ui-sans-serif, system-ui',
          'text-wrap': 'wrap', 'text-max-width': 130, 'text-valign': 'center',
          shape: 'round-rectangle', width: 156, height: 46, padding: 8 } },
      { selector: 'edge', style: {
          width: 1.6, 'line-color': '#cbd5e1', 'target-arrow-color': '#94a3b8',
          'target-arrow-shape': 'triangle', 'arrow-scale': 0.9,
          'curve-style': 'bezier', opacity: 0.85 } },
      { selector: '.faded', style: { opacity: 0.12 } },
      { selector: 'node.picked', style: { 'border-width': 3, 'border-color': '#1a1a1a' } },
      { selector: 'edge.lit', style: { 'line-color': '#0369a1', 'target-arrow-color': '#0369a1',
          width: 2.4, opacity: 1 } },
      { selector: 'node.lit', style: { opacity: 1 } },
    ],
    layout: { name: dagre ? 'dagre' : 'breadthfirst', rankDir: 'LR', nodeSep: 18, rankSep: 70, edgeSep: 10 },
  })

  const clearHighlight = () => cy.elements().removeClass('faded lit picked')
  const highlight = (node) => {
    cy.elements().addClass('faded')
    node.closedNeighborhood().removeClass('faded').addClass('lit')
    node.addClass('picked')
  }
  const list = (items, empty) =>
    items.length
      ? '<ul class="detail-list">' + items.map((i) => `<li>${i}</li>`).join('') + '</ul>'
      : `<p class="detail-empty">${empty}</p>`

  function summary() {
    const tally = { cleared: 0, open: 0, locked: 0, empty: 0 }
    cy.nodes().forEach((n) => { tally[n.data('state')]++ })
    const open = cy.nodes().filter((n) => n.data('state') === 'open')
      .map((n) => `<a href="#" data-goto="${escapeHtml(n.id())}">${escapeHtml(n.data('label'))}</a>`)
    detail.innerHTML = `
      <p class="rail-title">Where you are</p>
      <p class="detail-progress">${tally.cleared} cleared, ${tally.open} open now,
        ${tally.locked} waiting, ${tally.empty} not written yet</p>
      <p class="rail-title">Open to you now</p>
      ${list(open, 'Nothing open yet - start at the first topic.')}
      <p class="detail-empty">Click any topic for what it needs and what it unlocks.</p>`
    detail.querySelectorAll('[data-goto]').forEach((link) => {
      link.onclick = (event) => {
        event.preventDefault()
        const node = cy.$id(link.dataset.goto)
        highlight(node)
        showDetail(node)
        cy.animate({ center: { eles: node } }, { duration: 200 })
      }
    })
  }

  function showDetail(node) {
    const d = node.data()
    const states = { cleared: 'Cleared', open: 'Open to you now',
      locked: 'Needs something first', empty: 'Not written yet' }
    const written = d.nodes.length
      ? '<ul class="detail-list">' + d.nodes.map((n) =>
          `<li><a href="${escapeHtml(href(n.id))}">${escapeHtml(n.title)}</a> ${n.solved ? '<span class="tick">&#10003;</span>' : ''}` +
          `<span class="detail-kind">${escapeHtml(n.kind)}</span></li>`).join('') + '</ul>'
      : '<p class="detail-empty">Nothing written for this topic yet.</p>'
    detail.innerHTML = `
      <p class="detail-state ${d.state}">${states[d.state]}</p>
      <h2 class="detail-title">${escapeHtml(d.label)}</h2>
      <p class="detail-part">Part ${d.part} - ${escapeHtml(d.partName)}</p>
      <p class="detail-agent"><b>In the agent:</b> ${escapeHtml(d.agent || '-')}</p>
      <p class="detail-progress">${d.total ? `${d.solved} of ${d.total} challenges solved` : ''}</p>
      <p class="rail-title">Needs first</p>${list(d.requires.map(escapeHtml), 'Nothing - you can start here.')}
      <p class="rail-title">Unlocks</p>${list(d.unlocks.map(escapeHtml), 'Nothing yet.')}
      <p class="rail-title">Written for this topic</p>${written}`
  }

  cy.on('tap', 'node', (evt) => { highlight(evt.target); showDetail(evt.target) })
  cy.on('tap', (evt) => { if (evt.target === cy) { clearHighlight(); summary() } })
  cy.on('dbltap', (evt) => { if (evt.target === cy) cy.animate({ fit: { padding: 30 } }, { duration: 200 }) })

  const centreOfView = () => {
    const box = cy.container().getBoundingClientRect()
    return { x: box.width / 2, y: box.height / 2 }
  }
  doc.querySelectorAll('.map-controls button').forEach((button) => {
    button.onclick = () => {
      const what = button.dataset.zoom
      if (what === 'in') cy.zoom({ level: cy.zoom() * 1.25, renderedPosition: centreOfView() })
      if (what === 'out') cy.zoom({ level: cy.zoom() / 1.25, renderedPosition: centreOfView() })
      if (what === 'fit') cy.animate({ fit: { padding: 30 } }, { duration: 200 })
      if (what === 'reset') { clearHighlight(); summary(); cy.animate({ fit: { padding: 30 } }, { duration: 200 }) }
    }
  })

  doc.getElementById('map-search')?.addEventListener('input', (event) => {
    const term = event.target.value.trim().toLowerCase()
    if (!term) { clearHighlight(); return }
    const hits = cy.nodes().filter((n) => n.data('label').toLowerCase().includes(term))
    cy.elements().addClass('faded')
    hits.removeClass('faded').addClass('lit')
    if (hits.length) cy.fit(hits, 60)
  })

  // Fit the whole book when it reads at that size; otherwise start legible,
  // on where the reader can go next, with Fit one click away.
  cy.ready(() => {
    cy.fit(undefined, 30)
    if (cy.zoom() < READABLE_ZOOM) {
      const open = cy.nodes().filter((n) => n.data('state') === 'open')
      cy.zoom(READABLE_ZOOM)
      cy.center(open.length ? open : cy.nodes().first())
    }
    summary()
  })
  return cy
}
