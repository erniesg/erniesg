"""The plain reader's chrome: the chapter rail, the front page's bar, the map.

`preview.py` and the published site (through `manifest.py`) draw these from
here, so the plain look is the same wherever the book is opened. Every link
goes through `href(node_id)`, the URL of a node on that surface.
"""

from __future__ import annotations

import html
import json
import re

from render import PART_NAMES, load_topics

EDGE_KINDS = {
    "requires": ("#0369a1", "needs first"),
    "assessed-by": ("#15803d", "checked by"),
    "powers": ("#b45309", "builds part of the agent"),
    "instance-of": ("#7c3aed", "same pattern as"),
    "harder-variant-of": ("#be185d", "harder version of"),
}

HEADING = re.compile(r'<h2 id="([^"]+)">(.*?)</h2>', re.DOTALL)
TAGS = re.compile(r"<[^>]+>")


def chapter_rail(markup: str, node: dict | None, order: list[dict], href, map_href: str) -> str:
    """"In this chapter" and "Connected" beside a node, as one `<aside>`.

    `order` is the pool a connection may point at: a node outside it (not
    written yet, or not in this book) belongs on the map, not beside a chapter.
    """
    sections = "".join(
        f'<li><a href="#{anchor}" data-rail-section="{anchor}">'
        f"{html.escape(html.unescape(TAGS.sub('', text)).strip())}</a></li>"
        for anchor, text in HEADING.findall(markup)
    )
    blocks = ""
    if sections:
        blocks += f'<p class="rail-title">In this chapter</p><ol class="rail-list">{sections}</ol>'
    if node:
        nodes = {entry["id"]: entry for entry in order}
        links = ""
        for kind, (colour, label) in EDGE_KINDS.items():
            for target in (t for t in node.get(kind, []) if t in nodes):
                links += (
                    f'<li><span class="edge-dot" style="background:{colour}"></span>'
                    f'<span class="edge-label">{html.escape(label)}</span>'
                    f'<a href="{html.escape(href(target))}">{html.escape(nodes[target]["title"])}</a></li>'
                )
        if links:
            blocks += (
                f'<p class="rail-title">Connected</p><ul class="rail-list edges">{links}</ul>'
                f'<p class="rail-more"><a href="{html.escape(map_href)}" data-astro-reload>'
                "Open the map →</a></p>"
            )
    return f'<aside class="rail" data-book-rail>{blocks}</aside>' if blocks else ""


def front_navigation(order: list[dict], href, solved=frozenset()) -> str:
    """The front page's bar: "Contents · x/y solved", and › to the first page.

    It is a `chapter-progress` with no chapter, so the look of the chapter bar
    and the shortcuts come with it: `]` goes to the first page. A surface that
    learns what is solved after render time fills `[data-progress-solved]`.
    """
    challenges = [n["id"] for n in order if n.get("kind") == "challenge"]
    done = sum(1 for c in challenges if c in solved)
    first = order[0] if order else None
    if first:
        label = html.escape(f"Next: {first['title']}")
        following = (
            f'<a class="cp-step" rel="next" href="{html.escape(href(first["id"]))}" '
            f'aria-label="{label}" title="{label} (])" aria-keyshortcuts="]">›</a>'
        )
    else:
        following = '<span class="cp-step" aria-hidden="true"></span>'
    status = (
        '<span class="cp-status" data-progress-solved '
        f'data-challenge-ids="{html.escape(" ".join(challenges))}">'
        f"{done}/{len(challenges)} solved</span>"
        if challenges
        else ""
    )
    return (
        '<nav class="chapter-progress" data-chapter-progress data-kind="front" '
        'aria-label="Where you are">'
        '<span class="cp-step" aria-hidden="true"></span>'
        '<div class="cp-body"><div class="cp-head">'
        f'<span class="cp-chapter">Contents</span>{status}</div></div>'
        f"{following}"
        '<button type="button" class="cp-keys" data-book-keys-toggle '
        'aria-keyshortcuts="?" aria-label="Keyboard shortcuts" '
        'title="Keyboard shortcuts (?)">?</button></nav>'
    )


def map_payload(order: list[dict]) -> dict:
    """Every topic, what it needs first, and what `order` has written for it.

    A topic's state (cleared, open, locked, not written) depends on what the
    reader has solved, which only the page knows on the site, so `MAP_SCRIPT`
    works it out in the browser from this and the solved list.
    """
    topics = load_topics()
    attached: dict[str, list[dict]] = {topic_id: [] for topic_id in topics}
    for node in order:
        for topic_id in node.get("teaches", []):
            if topic_id in attached:
                attached[topic_id].append(node)
    return {
        "topics": [
            {
                "id": topic_id,
                "title": topic["title"],
                "part": int(topic.get("part", 0)),
                "partName": PART_NAMES.get(int(topic.get("part", 0)), ""),
                "agent": topic.get("agent", ""),
                "requires": [r for r in topic.get("requires", []) if r in topics],
                "nodes": [
                    {"id": n["id"], "title": n["title"], "kind": n.get("kind", "")}
                    for n in attached[topic_id]
                ],
            }
            for topic_id, topic in topics.items()
        ]
    }


MAP_CDN = (
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>'
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js"></script>'
    '<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js"></script>'
)


def map_markup(payload: dict, href_template: str) -> str:
    """The map page's body. `href_template` has `{id}` where a node id goes.

    It ends with the graph library and `MAP_SCRIPT`, which defines
    `window.bookMap(solved)`; the surface calls it once it knows what is solved.
    """
    data = json.dumps(payload).replace("<", "\\u003c")
    return f"""<h1>The map</h1>
<p class="lede">Every topic in the book and what it needs first. Click one to see
what it unlocks and what is written for it.</p>
<p class="edition" data-map-counts></p>
<div class="map-tools">
  <input id="map-search" type="search" placeholder="Find a topic" autocomplete="off" aria-label="Find a topic">
  <span class="legend-item"><i class="swatch cleared"></i>cleared</span>
  <span class="legend-item"><i class="swatch open"></i>open now</span>
  <span class="legend-item"><i class="swatch locked"></i>locked</span>
  <span class="legend-item"><i class="swatch empty"></i>not written</span>
</div>
<div class="map-wrap"><div class="map-stage"><div id="map" data-href="{html.escape(href_template)}"></div>
  <div class="map-controls">
    <button data-zoom="in" title="Zoom in">+</button>
    <button data-zoom="out" title="Zoom out">−</button>
    <button data-zoom="fit" title="Fit to screen">Fit</button>
    <button data-zoom="reset" title="Back to the start">Reset</button>
  </div></div><aside id="map-detail" class="map-detail"></aside></div>
<script id="map-data" type="application/json">{data}</script>
{MAP_CDN}<script>{MAP_SCRIPT}</script>"""


def print_markup(order: list[dict], render) -> str:
    """The whole book in reading order, as the print edition lays it out.

    `render(node)` is the node rendered for the print target.
    """
    return "".join(
        f"<article class='print-page' id='print-{html.escape(node['id'])}'>{render(node)}</article>"
        for node in order
    )


MAP_SCRIPT = r"""
window.bookMap = function bookMap(solvedList) {
const MAP_COLOURS = {
  cleared: { bg: '#dcfce7', line: '#15803d', text: '#14532d' },
  open:    { bg: '#e0f2fe', line: '#0369a1', text: '#0c4a6e' },
  locked:  { bg: '#f1f1ef', line: '#9ca3af', text: '#4b5563' },
  empty:   { bg: '#fafaf8', line: '#d4d4d4', text: '#6b7280' },
};
const container = document.getElementById('map');
if (!container || container.dataset.drawn) return;
container.dataset.drawn = '1';
const template = container.dataset.href || '/{id}';
const hrefOf = id => template.replace('{id}', encodeURIComponent(id));
const escapeHtml = value => String(value).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const payload = JSON.parse(document.getElementById('map-data').textContent);
const solved = new Set(solvedList || []);
const topics = new Map(payload.topics.map(t => [t.id, t]));

const memo = new Map();
function state(id, seen) {
  if (!seen && memo.has(id)) return memo.get(id);
  const topic = topics.get(id);
  const challenges = topic.nodes.filter(n => n.kind === 'challenge');
  let result;
  if (challenges.length && challenges.every(n => solved.has(n.id))) result = 'cleared';
  else if (!topic.nodes.length) result = 'empty';
  else {
    const visited = new Set(seen || []); visited.add(id);
    const parents = topic.requires.filter(r => topics.has(r) && !visited.has(r));
    result = parents.every(r => state(r, visited) === 'cleared') ? 'open' : 'locked';
  }
  if (!seen) memo.set(id, result);
  return result;
}

const elements = [];
for (const topic of payload.topics) {
  const challenges = topic.nodes.filter(n => n.kind === 'challenge');
  elements.push({ data: {
    id: topic.id, label: topic.title, state: state(topic.id), part: topic.part,
    partName: topic.partName, agent: topic.agent,
    solved: challenges.filter(n => solved.has(n.id)).length, total: challenges.length,
    requires: topic.requires.map(r => topics.get(r).title),
    unlocks: payload.topics.filter(o => o.requires.includes(topic.id)).map(o => o.title),
    nodes: topic.nodes.map(n => ({ ...n, solved: solved.has(n.id) })),
  } });
}
for (const topic of payload.topics) {
  for (const parent of topic.requires) {
    elements.push({ data: { id: `${parent}->${topic.id}`, source: parent, target: topic.id } });
  }
}
const counts = document.querySelector('[data-map-counts]');
if (counts) {
  const nodes = elements.filter(e => !e.data.source);
  counts.textContent = `${nodes.length} topics · ` +
    `${nodes.filter(e => e.data.state === 'cleared').length} cleared · ` +
    `${nodes.filter(e => e.data.nodes.length).length} with content written`;
}

cytoscape.use(cytoscapeDagre);
const cy = cytoscape({
  container,
  elements,
  wheelSensitivity: 0.2,
  style: [
    { selector: 'node', style: {
        'background-color': n => MAP_COLOURS[n.data('state')].bg,
        'border-color': n => MAP_COLOURS[n.data('state')].line,
        'border-width': n => n.data('state') === 'cleared' ? 2.5 : 1.5,
        'border-style': n => n.data('state') === 'empty' ? 'dashed' : 'solid',
        'label': 'data(label)', 'color': n => MAP_COLOURS[n.data('state')].text,
        'font-size': 12, 'font-family': 'ui-sans-serif, system-ui',
        'text-wrap': 'wrap', 'text-max-width': 130, 'text-valign': 'center',
        'shape': 'round-rectangle', 'width': 156, 'height': 46, 'padding': 8 } },
    { selector: 'edge', style: {
        'width': 1.6, 'line-color': '#cbd5e1', 'target-arrow-color': '#94a3b8',
        'target-arrow-shape': 'triangle', 'arrow-scale': .9,
        'curve-style': 'bezier', 'opacity': .85 } },
    { selector: '.faded', style: { 'opacity': .12 } },
    { selector: 'node.picked', style: { 'border-width': 3, 'border-color': '#1a1a1a' } },
    { selector: 'edge.lit', style: { 'line-color': '#0369a1', 'target-arrow-color': '#0369a1',
        'width': 2.4, 'opacity': 1 } },
    { selector: 'node.lit', style: { 'opacity': 1 } },
  ],
  layout: { name: 'dagre', rankDir: 'LR', nodeSep: 18, rankSep: 70, edgeSep: 10 },
});

const detail = document.getElementById('map-detail');
const clearHighlight = () => cy.elements().removeClass('faded lit picked');

function highlight(node) {
  cy.elements().addClass('faded');
  node.closedNeighborhood().removeClass('faded').addClass('lit');
  node.addClass('picked');
}

function list(items, empty) {
  return items.length
    ? '<ul class="detail-list">' + items.map(i => `<li>${i}</li>`).join('') + '</ul>'
    : `<p class="detail-empty">${empty}</p>`;
}

function summary() {
  const tally = { cleared: 0, open: 0, locked: 0, empty: 0 };
  cy.nodes().forEach(n => tally[n.data('state')]++);
  const open = cy.nodes().filter(n => n.data('state') === 'open')
    .map(n => `<a href="#" data-goto="${escapeHtml(n.id())}">${escapeHtml(n.data('label'))}</a>`);
  detail.innerHTML = `
    <p class="rail-title">Where you are</p>
    <p class="detail-progress">${tally.cleared} cleared, ${tally.open} open now,
      ${tally.locked} waiting, ${tally.empty} not written yet</p>
    <p class="rail-title">Open to you now</p>
    ${list(open, 'Nothing open yet - start at the first topic.')}
    <p class="detail-empty">Click any topic for what it needs and what it unlocks.</p>`;
  detail.querySelectorAll('[data-goto]').forEach(link => {
    link.onclick = event => {
      event.preventDefault();
      const node = cy.$id(link.dataset.goto);
      highlight(node); showDetail(node);
      cy.animate({ center: { eles: node } }, { duration: 200 });
    };
  });
}

function showDetail(node) {
  const d = node.data();
  const states = { cleared: 'Cleared', open: 'Open to you now',
                   locked: 'Needs something first', empty: 'Not written yet' };
  const written = d.nodes.length
    ? '<ul class="detail-list">' + d.nodes.map(n =>
        `<li><a href="${escapeHtml(hrefOf(n.id))}">${escapeHtml(n.title)}</a> ` +
        `${n.solved ? '<span class="tick">&#10003;</span>' : ''}` +
        `<span class="detail-kind">${escapeHtml(n.kind)}</span></li>`).join('') + '</ul>'
    : '<p class="detail-empty">Nothing written for this topic yet.</p>';
  detail.innerHTML = `
    <p class="detail-state ${d.state}">${states[d.state]}</p>
    <h2 class="detail-title">${escapeHtml(d.label)}</h2>
    <p class="detail-part">Part ${escapeHtml(d.part)} - ${escapeHtml(d.partName)}</p>
    <p class="detail-agent"><b>In the agent:</b> ${escapeHtml(d.agent || '-')}</p>
    <p class="detail-progress">${d.total ? `${d.solved} of ${d.total} challenges solved` : ''}</p>
    <p class="rail-title">Needs first</p>${list(d.requires.map(escapeHtml), 'Nothing - you can start here.')}
    <p class="rail-title">Unlocks</p>${list(d.unlocks.map(escapeHtml), 'Nothing yet.')}
    <p class="rail-title">Written for this topic</p>${written}`;
}

cy.on('tap', 'node', evt => { highlight(evt.target); showDetail(evt.target); });
cy.on('tap', evt => { if (evt.target === cy) { clearHighlight(); summary(); } });
cy.on('dbltap', evt => { if (evt.target === cy) cy.animate({ fit: { padding: 30 } }, { duration: 200 }); });

const centreOfView = () => {
  const box = cy.container().getBoundingClientRect();
  return { x: box.width / 2, y: box.height / 2 };
};

document.querySelectorAll('.map-controls button').forEach(button => {
  button.onclick = () => {
    const what = button.dataset.zoom;
    if (what === 'in') cy.zoom({ level: cy.zoom() * 1.25, renderedPosition: centreOfView() });
    if (what === 'out') cy.zoom({ level: cy.zoom() / 1.25, renderedPosition: centreOfView() });
    if (what === 'fit') cy.animate({ fit: { padding: 30 } }, { duration: 200 });
    if (what === 'reset') { clearHighlight(); summary(); cy.animate({ fit: { padding: 30 } }, { duration: 200 }); }
  };
});

document.getElementById('map-search').addEventListener('input', event => {
  const term = event.target.value.trim().toLowerCase();
  if (!term) { clearHighlight(); return; }
  const hits = cy.nodes().filter(n => n.data('label').toLowerCase().includes(term));
  cy.elements().addClass('faded');
  hits.removeClass('faded').addClass('lit');
  if (hits.length) cy.fit(hits, 60);
});

cy.ready(() => { cy.fit(undefined, 30); summary(); });
};
"""


# The rail's and the map's styles. Colours come from the book's variables
# (`--ink`, `--dim`, `--line`, `--accent`, `--panel`), which each surface sets.
RAIL_CSS = """
.rail { position:sticky; top:var(--rail-top, 64px); align-self:start;
  max-height:calc(100vh - var(--rail-top, 64px) - 26px); overflow:auto;
  font:.85rem/1.5 ui-sans-serif,system-ui; padding-left:1.2rem; border-left:1px solid var(--line); }
.rail-title { font:600 .7rem ui-sans-serif,system-ui; letter-spacing:.08em; text-transform:uppercase;
  color:var(--dim); margin:0 0 .5rem; }
.rail-list { list-style:none; padding:0; margin:0 0 1.6rem; }
.rail-list li { margin:.3rem 0; }
.rail-list a { color:var(--ink); text-decoration:none; }
.rail-list a:hover, .rail-list a[aria-current] { color:var(--accent); }
.edges li { display:grid; grid-template-columns:8px 1fr; gap:6px; align-items:baseline; margin:.5rem 0; }
.edge-dot { width:8px; height:8px; border-radius:50%; margin-top:.35rem; }
.edge-label { grid-column:2; font-size:.72rem; color:var(--dim); display:block; }
.edges a { grid-column:2; }
.rail-more { font-size:.78rem; }
.rail-more a { color:var(--accent); text-decoration:none; }
"""

MAP_CSS = """
.lede { font-size:1.1rem; }
.edition { font:.85rem ui-sans-serif,system-ui; color:var(--dim); }
.map-tools { display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin:14px 0 10px;
  font:.78rem ui-sans-serif,system-ui; color:var(--dim); }
#map-search { font:inherit; padding:5px 10px; border:1px solid var(--line); border-radius:6px;
  min-width:180px; background:var(--panel, #fff); color:var(--ink); }
.legend-item { display:flex; align-items:center; gap:5px; }
.swatch { width:12px; height:12px; border-radius:3px; display:inline-block; border:1.5px solid; }
.swatch.cleared { background:#dcfce7; border-color:#15803d; }
.swatch.open { background:#e0f2fe; border-color:#0369a1; }
.swatch.locked { background:#f1f1ef; border-color:#9ca3af; }
.swatch.empty { background:#fafaf8; border-color:#d4d4d4; border-style:dashed; }
.map-wrap { display:grid; grid-template-columns:minmax(0,1fr) 19rem; gap:1.2rem; align-items:start; }
.map-stage { position:relative; }
#map { height:70vh; min-height:460px; border:1px solid var(--line); border-radius:10px; background:#fff; }
.map-controls { position:absolute; left:12px; bottom:12px; display:flex; gap:6px;
  background:rgba(255,255,255,.94); border:1px solid var(--line); border-radius:8px; padding:4px; }
.map-controls button { font:600 .8rem ui-sans-serif,system-ui; min-width:30px; padding:4px 8px;
  border:0; border-radius:5px; background:transparent; cursor:pointer; color:#1a1a1a; }
.map-controls button:hover { background:#f0efe9; }
.map-detail { border:1px solid var(--line); border-radius:10px; background:var(--panel, #fff);
  padding:14px 16px; font:.87rem/1.5 ui-sans-serif,system-ui; max-height:70vh; overflow:auto; }
.detail-empty { color:var(--dim); font-size:.82rem; }
.detail-state { display:inline-block; font:600 .7rem ui-sans-serif,system-ui; letter-spacing:.06em;
  text-transform:uppercase; padding:3px 8px; border-radius:20px; margin:0 0 .5rem; }
.detail-state.cleared { background:#dcfce7; color:#14532d; }
.detail-state.open { background:#e0f2fe; color:#0c4a6e; }
.detail-state.locked { background:#f1f1ef; color:#4b5563; }
.detail-state.empty { background:#fafaf8; color:#6b7280; }
.detail-title { font:600 1.05rem ui-sans-serif,system-ui; margin:.1rem 0; }
.detail-part { color:var(--dim); font-size:.82rem; margin:.1rem 0 .4rem; }
.detail-agent { margin:.5rem 0 .35rem; }
.detail-progress { margin:.35rem 0 .2rem; color:var(--dim); font-size:.82rem; }
.detail-list { margin:.35rem 0 1.15rem; padding-left:1.15rem; }
.detail-list li { margin:.22rem 0; }
.detail-list a { color:var(--accent); text-decoration:none; }
.detail-kind { color:var(--dim); font-size:.75rem; margin-left:.4rem; }
.map-detail .rail-title { margin:1.15rem 0 0; padding-top:.9rem; border-top:1px solid var(--line); }
.map-detail .rail-title:first-of-type { border-top:0; padding-top:0; }
.tick { color:#15803d; }
.print-page { border-bottom:1px solid var(--line); padding-bottom:2rem; margin-bottom:2rem; }
@media (max-width:1100px) { .map-wrap { grid-template-columns:minmax(0,1fr); } }
"""
