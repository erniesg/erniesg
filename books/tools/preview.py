#!/usr/bin/env python3
"""Read the book locally, one column, exercises inline.

    python3 books/tools/preview.py [--port 8770] [--no-open]

This is a local preview of the node format, not the published site. It binds to
localhost, renders whatever is on disk on every request, and grades through the
same tier tests the site will use. Your code runs in subprocesses on your own
machine, exactly as `grade.py` runs it.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

if sys.version_info < (3, 11):
    sys.exit(f"This needs Python 3.11+; this is Python {sys.version.split()[0]}.")

import tomllib

import grade as grader
from markdown import render_markdown
from render import (
    BOOKS,
    WORKSPACE,
    all_nodes,
    load_topics,
    CARD_BLOCKS,
    CONTENT_AT_RULES,
    CONTENT_CSS,
    PART_NAMES,
    all_nodes,
    figure as render_figure,
    load_book,
    load_node,
    load_topics,
    problem_card as render_problem_card,
    render_node,
    split_blocks,
)


BLOCK = re.compile(r"^:::(\w+)(\{[^}]*\})?\s*$", re.MULTILINE)
ATTR = re.compile(r'(\w+)\s*=\s*"?([^",}\s]+)"?')

def read_progress() -> dict:
    if PROGRESS_PATH.is_file():
        try:
            return json.loads(PROGRESS_PATH.read_text())
        except json.JSONDecodeError:
            pass
    return {"solved": []}


def write_progress(progress: dict) -> None:
    PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS_PATH.write_text(json.dumps(progress, indent=2))


PROGRESS_PATH = WORKSPACE / "progress.json"

HEADING = re.compile(r'<h2 id="([^"]+)">(.*?)</h2>')

EDGE_KINDS = {
    "requires": ("#0369a1", "needs first"),
    "assessed-by": ("#15803d", "checked by"),
    "powers": ("#b45309", "builds part of the agent"),
    "instance-of": ("#7c3aed", "same pattern as"),
    "harder-variant-of": ("#be185d", "harder version of"),
}

STYLE = CONTENT_CSS + CONTENT_AT_RULES + """
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
  font:17px/1.65 "Iowan Old Style","Palatino Linotype",Georgia,serif; }
.scroll-progress { position:fixed; top:0; left:0; right:0; height:2px; z-index:20; }
.scroll-progress i { display:block; height:100%; width:0; background:var(--accent); }
header.top { position:sticky; top:0; z-index:16; background:var(--bg);
  border-bottom:1px solid var(--line); padding:9px 16px; display:flex; gap:12px; align-items:center; }
.contents-button { font:600 .8rem ui-sans-serif,system-ui; padding:4px 11px;
  border:1px solid var(--line); border-radius:6px; background:#fff; cursor:pointer; }
.book-title { font:600 .9rem ui-sans-serif,system-ui; color:var(--accent); text-decoration:none; }
.chrome-link { font:.8rem ui-sans-serif,system-ui; color:var(--accent); text-decoration:none; }
.progress { margin-left:auto; display:flex; align-items:center; gap:8px; }
.bar { width:120px; height:5px; background:var(--line); border-radius:3px; overflow:hidden; }
.bar i { display:block; height:100%; background:var(--accent); }
.progress-text { font:.72rem ui-sans-serif,system-ui; color:var(--dim); white-space:nowrap; }
.drawer { position:fixed; top:44px; bottom:0; left:0; width:270px; background:#fff;
  border-right:1px solid var(--line); z-index:15; overflow:auto; }
.drawer[hidden] { display:none; }
.drawer-inner { padding:16px 14px 50px; }
.drawer-title { font:600 .72rem ui-sans-serif,system-ui; letter-spacing:.09em;
  text-transform:uppercase; color:var(--dim); margin:0; }
.scrim { position:fixed; inset:44px 0 0 0; background:transparent; z-index:14; }
.toc { list-style:none; padding:0; margin:12px 0 0; }
.toc-part { font:600 .72rem ui-sans-serif,system-ui; letter-spacing:.08em; text-transform:uppercase;
  color:var(--dim); margin:18px 0 6px; }
.toc-row a { display:grid; grid-template-columns:auto 1fr auto; gap:8px; align-items:baseline;
  padding:6px 8px; border-radius:6px; text-decoration:none; color:var(--ink);
  font:.92rem/1.35 ui-sans-serif,system-ui; }
.toc-row a:hover { background:#f0efe9; }
.toc-row.here a { background:#e6f1f7; }
.toc-row a > .toc-title:first-child { grid-column:1 / 3; }
.toc-num { color:var(--dim); font-size:.78rem; font-variant-numeric:tabular-nums; min-width:1.4em;
  text-align:right; }
.toc-row:not(.toc-practice) .toc-title { font-weight:600; }
.toc-practice a { padding-top:3px; padding-bottom:3px; font-size:.84rem; color:#444; }
.toc-practice .toc-title { padding-left:.9em; border-left:2px solid var(--line); }
.toc-kind { display:block; font:600 .62rem ui-sans-serif,system-ui; letter-spacing:.08em;
  text-transform:uppercase; color:#15803d; }
.toc-tick { color:#15803d; font-size:.8rem; }
.planned-row a { color:var(--dim); }
.planned-row a:hover { background:#f6f6f4; }
.toc-soon { font-size:.7rem; color:var(--dim); font-style:italic; }
main { display:grid; grid-template-columns:minmax(0,40rem) 17rem; gap:3rem;
  justify-content:center; padding:28px 24px 80px; }
main > article { min-width:0; }
main.wide { grid-template-columns:minmax(0,60rem); }
.rail { position:sticky; top:64px; align-self:start; max-height:calc(100vh - 90px); overflow:auto;
  font:.85rem/1.5 ui-sans-serif,system-ui; padding-left:1.2rem; border-left:1px solid var(--line); }
.rail-outline summary { font:600 .7rem ui-sans-serif,system-ui; letter-spacing:.08em;
  text-transform:uppercase; color:var(--dim); cursor:pointer; list-style:none; }
.rail-outline summary::before { content:"\2630"; margin-right:.45em; font-size:.9rem; }
.rail-outline summary::-webkit-details-marker { display:none; }
.rail-outline { margin-bottom:1.4rem; }
.rail-outline[open] summary { margin-bottom:.5rem; }
.rail-title { font:600 .7rem ui-sans-serif,system-ui; letter-spacing:.08em; text-transform:uppercase;
  color:var(--dim); margin:0 0 .5rem; }
.rail-list { list-style:none; padding:0; margin:0 0 1.6rem; }
.rail-list li { margin:.3rem 0; }
.rail-list a { color:var(--ink); text-decoration:none; }
.rail-list a:hover { color:var(--accent); }
.edges li { display:grid; grid-template-columns:8px 1fr; gap:6px; align-items:baseline; margin:.5rem 0; }
.edge-dot { width:8px; height:8px; border-radius:50%; margin-top:.35rem; }
.edge-label { grid-column:2; font-size:.72rem; color:var(--dim); display:block; }
.edges a, .planned { grid-column:2; }
.planned { color:var(--dim); font-style:italic; }
.rail-more { font-size:.78rem; }
.rail-more a { color:var(--accent); text-decoration:none; }
.lede { font-size:1.1rem; color:#333; }
.edition { font:.85rem ui-sans-serif,system-ui; color:var(--dim); }
.walk-row, .walk-state { display:flex; gap:6px; align-items:center; margin:6px 0; }
.walk-item, .slot { min-width:34px; text-align:center; padding:5px 6px; border:1px solid var(--line);
  border-radius:5px; font:.9rem ui-monospace,monospace; background:var(--bg); }
.walk-item.on { background:#fde68a; border-color:#d97706; }
.walk-label { width:72px; font:.72rem ui-sans-serif,system-ui; color:var(--dim); }
.slot { visibility:hidden; }
.slot.on { visibility:visible; }
.walk-controls { display:flex; gap:10px; align-items:center; margin-top:10px;
  font:.8rem ui-sans-serif,system-ui; color:var(--dim); }
.walk-controls button { font:inherit; padding:3px 9px; border:1px solid var(--line);
  border-radius:5px; background:#fff; cursor:pointer; }
.map-tools { display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin:14px 0 10px;
  font:.78rem ui-sans-serif,system-ui; color:var(--dim); }
#map-search { font:inherit; padding:5px 10px; border:1px solid var(--line); border-radius:6px;
  min-width:180px; }
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
  border:0; border-radius:5px; background:transparent; cursor:pointer; color:var(--ink); }
.map-controls button:hover { background:#f0efe9; }
.map-detail { border:1px solid var(--line); border-radius:10px; background:#fff; padding:14px 16px;
  font:.87rem/1.5 ui-sans-serif,system-ui; max-height:70vh; overflow:auto; }
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
nav.turn { display:flex; justify-content:space-between; margin-top:3rem;
  border-top:1px solid var(--line); padding-top:1rem; font:.9rem ui-sans-serif,system-ui; }
nav.turn a { color:var(--accent); text-decoration:none; }
@media (max-width:1279px) { main { grid-template-columns:minmax(0,40rem); } .rail { display:none; } }
@media (max-width:1100px) { .map-wrap { grid-template-columns:minmax(0,1fr); } }
@media (max-width:480px) { body { font-size:16px; } main { padding:20px 16px 60px; } }
"""


def contents_html(order: list[dict], current: str = "") -> str:
    """The whole book, not just the pages that exist yet.

    Written nodes are listed where they belong; topics with nothing written are
    greyed and point at the map. A reader can see the shape of the book and how
    much of it is standing.
    """
    topics = load_topics()
    written_topics = {
        topic_id
        for node in all_nodes().values()
        for topic_id in node.get("teaches", [])
    }

    by_part: dict[str, list[dict]] = {}
    intro = []
    for node in order:
        if node.get("part_number") == "" or not node.get("part"):
            intro.append(node)
        else:
            by_part.setdefault(node["part_number"], []).append(node)

    rows: list[str] = []

    def row(node: dict) -> str:
        practice = node.get("chapter_number") is not None
        number = (
            f'<span class="toc-num">{html.escape(node["number"])}</span>'
            if node.get("number") else '<span class="toc-num"></span>'
        )
        tick = '<span class="toc-tick">\u2713</span>' if node.get("solved") else ""
        classes = "toc-row" + (" toc-practice" if practice else "") + (" here" if node["id"] == current else "")
        label = '<span class="toc-kind">practice</span>' if practice else ""
        return (
            f'<li class="{classes}"><a href="/{html.escape(node["id"])}">{number}'
            f'<span class="toc-title">{label}{html.escape(node["title"])}</span>{tick}</a></li>'
        )

    if intro:
        rows.append('<li class="toc-part">Introduction</li>')
        rows.extend(row(node) for node in intro)

    parts = sorted(
        {str(topic.get("part", 0)) for topic in topics.values()} | set(by_part),
        key=lambda value: int(value),
    )
    for part in parts:
        rows.append(
            f'<li class="toc-part">Part {html.escape(part)} \u00b7 '
            f'{html.escape(PART_NAMES.get(int(part), ""))}</li>'
        )
        for node in by_part.get(part, []):
            rows.append(row(node))
        planned = [
            topic
            for topic in topics.values()
            if str(topic.get("part", 0)) == part and topic["id"] not in written_topics
        ]
        for topic in planned:
            rows.append(
                f'<li class="toc-row planned-row"><a href="/map">'
                f'<span class="toc-title">{html.escape(topic["title"])}</span>'
                f'<span class="toc-soon">to come</span></a></li>'
            )
    return f'<ol class="toc">{"".join(rows)}</ol>'


def render_rail(rendered: str, node: dict | None) -> str:
    sections = "".join(
        f'<li><a href="#{anchor}">{html.escape(html.unescape(re.sub("<[^>]+>", "", text)))}</a></li>'
        for anchor, text in HEADING.findall(rendered)
    )
    blocks = ""
    if sections:
        blocks += f'<p class="rail-title">In this chapter</p><ol class="rail-list">{sections}</ol>'
    if node:
        nodes = all_nodes()
        links = ""
        for kind, (colour, label) in EDGE_KINDS.items():
            # Edges to nodes not written yet belong on the map, not beside a chapter.
            for target in (t for t in node.get(kind, []) if t in nodes):
                name = nodes[target]["title"]
                item = f'<a href="/{html.escape(target)}">{html.escape(name)}</a>'
                links += (
                    f'<li><span class="edge-dot" style="background:{colour}"></span>'
                    f'<span class="edge-label">{html.escape(label)}</span>{item}</li>'
                )
        if links:
            blocks += (
                f'<p class="rail-title">Connected</p><ul class="rail-list edges">{links}</ul>'
                f'<p class="rail-more"><a href="/map">Open the map →</a></p>'
            )
    return f'<aside class="rail">{blocks}</aside>' if blocks else ""


def graph_payload() -> dict:
    """Nodes and edges for the map, with the state each topic is in."""
    topics = load_topics()
    nodes = all_nodes()
    solved = set(read_progress().get("solved", []))

    attached: dict[str, list[dict]] = {topic_id: [] for topic_id in topics}
    for node in nodes.values():
        for topic_id in node.get("teaches", []):
            if topic_id in attached:
                attached[topic_id].append(node)

    def state(topic_id: str, seen: frozenset = frozenset()) -> str:
        here = attached[topic_id]
        challenges = [n for n in here if n.get("kind") == "challenge"]
        if challenges and all(n["id"] in solved for n in challenges):
            return "cleared"
        if not here:
            return "empty"
        parents = [r for r in topics[topic_id]["requires"] if r in topics and r not in seen]
        if all(state(r, seen | {topic_id}) == "cleared" for r in parents):
            return "open"
        return "locked"

    elements = []
    for topic_id, topic in topics.items():
        challenges = [n for n in attached[topic_id] if n.get("kind") == "challenge"]
        done = sum(1 for n in challenges if n["id"] in solved)
        elements.append({
            "data": {
                "id": topic_id,
                "label": topic["title"],
                "state": state(topic_id),
                "part": topic.get("part", 0),
                "partName": PART_NAMES.get(topic.get("part", 0), ""),
                "agent": topic.get("agent", ""),
                "solved": done,
                "total": len(challenges),
                "requires": [topics[r]["title"] for r in topic["requires"] if r in topics],
                "unlocks": [
                    other["title"] for other in topics.values() if topic_id in other["requires"]
                ],
                "nodes": [
                    {"id": n["id"], "title": n["title"], "kind": n.get("kind", ""),
                     "solved": n["id"] in solved}
                    for n in attached[topic_id]
                ],
            }
        })
    for topic_id, topic in topics.items():
        for parent in topic["requires"]:
            if parent in topics:
                elements.append({"data": {"id": f"{parent}->{topic_id}",
                                          "source": parent, "target": topic_id}})
    return {"elements": elements, "counts": {
        "topics": len(topics),
        "cleared": sum(1 for t in topics if state(t) == "cleared"),
        "written": sum(1 for t in topics if attached[t]),
    }}


def render_map() -> str:
    payload = graph_payload()
    counts = payload["counts"]
    return f'''<h1>The map</h1>
<p class="lede">Every topic in the book and what it needs first. Click one to see
what it unlocks and what is written for it.</p>
<p class="edition">{counts["topics"]} topics · {counts["cleared"]} cleared ·
{counts["written"]} with content written</p>
<div class="map-tools">
  <input id="map-search" type="search" placeholder="Find a topic" autocomplete="off">
  <span class="legend-item"><i class="swatch cleared"></i>cleared</span>
  <span class="legend-item"><i class="swatch open"></i>open now</span>
  <span class="legend-item"><i class="swatch locked"></i>locked</span>
  <span class="legend-item"><i class="swatch empty"></i>not written</span>
</div>
<div class="map-wrap"><div class="map-stage"><div id="map"></div>
  <div class="map-controls">
    <button data-zoom="in" title="Zoom in">+</button>
    <button data-zoom="out" title="Zoom out">−</button>
    <button data-zoom="fit" title="Fit to screen">Fit</button>
    <button data-zoom="reset" title="Back to the start">Reset</button>
  </div></div><aside id="map-detail" class="map-detail"></aside></div>
<script id="map-data" type="application/json">{json.dumps(payload["elements"])}</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js"></script>
<script>{MAP_SCRIPT}</script>'''


def page(title: str, inner: str, book_title: str, order: list[dict], current: str = "",
         node: dict | None = None, wide: bool = False, rail: str | None = None) -> bytes:
    positions = [n["id"] for n in order]
    place = positions.index(current) + 1 if current in positions else 0
    solved = sum(1 for n in order if n.get("solved"))
    gradeable = sum(1 for n in order if n.get("kind") == "challenge")
    through = int(place / max(len(positions), 1) * 100)
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} — {html.escape(book_title)}</title><style>{STYLE}</style></head>
<body>
<div class="scroll-progress"><i></i></div>
<header class="top">
  <button class="contents-button" aria-expanded="false">Contents</button>
  <a class="book-title" href="/">{html.escape(book_title)}</a>
  <a class="graph-link" href="/map">Map</a>
  <a class="graph-link" href="/print{'#print-' + html.escape(current) if current else ''}">Print</a>
  <div class="progress" title="{place} of {len(positions)} in this book">
    <div class="bar"><i style="width:{through}%"></i></div>
    <span class="progress-text">{place}/{len(positions)} · {solved}/{gradeable} solved</span>
  </div>
</header>
<div class="scrim" hidden></div>
<aside class="drawer" hidden><div class="drawer-inner">
  {contents_html(order, current)}
</div></aside>
<main class="{'wide' if wide else ''}"><article>{inner}</article>{(rail if rail is not None else render_rail(inner, node)) if not wide else ''}</main>
<script>{SCRIPT}</script></body></html>""".encode()


SCRIPT = r"""
document.querySelectorAll('.walk').forEach(walk => {
  const steps = Number(walk.dataset.steps) || 1;
  let step = 0;
  const paint = () => {
    walk.querySelectorAll('.walk-item').forEach(el =>
      el.classList.toggle('on', Number(el.dataset.index) === step));
    walk.querySelectorAll('.slot').forEach(el =>
      el.classList.toggle('on', Number(el.dataset.step) <= step));
    walk.querySelector('.walk-step b').textContent = step + 1;
    walk.querySelectorAll('.walk-note').forEach(el => { el.hidden = Number(el.dataset.index) !== step; });
    const answer = walk.querySelector('.walk-answer');
    if (answer) answer.hidden = step !== steps - 1;
  };
  walk.querySelector('[data-walk="next"]').onclick = () => { step = Math.min(step + 1, steps - 1); paint(); };
  walk.querySelector('[data-walk="back"]').onclick = () => { step = Math.max(step - 1, 0); paint(); };
  paint();
});

const runnableCells = [...document.querySelectorAll('.cell-run')];
runnableCells.forEach((cell, index) => {
  const button = cell.querySelector('.exec');
  const status = cell.querySelector('.status');
  const output = cell.querySelector('.output');
  button.onclick = async () => {
    button.disabled = true; button.classList.add('busy'); status.textContent = 'Running';
    output.textContent = ''; output.classList.remove('error');
    const earlier = runnableCells.slice(0, index)
      .map((c, cellIndex) => ({
        index: cellIndex + 1,
        source: c.querySelector('.editor').value,
      }));
    try {
      const response = await fetch('/api/exec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: cell.querySelector('.editor').value, earlier }),
      });
      const result = await response.json();
      output.textContent = result.output;
      output.classList.toggle('error', result.ok === false);
      status.textContent = '';
    } catch (error) { status.textContent = String(error); }
    finally { button.disabled = false; button.classList.remove('busy'); }
  };
});

document.querySelectorAll('.desk').forEach(desk => {
  const button = desk.querySelector('.run');
  const status = desk.querySelector('.status');
  const tiers = desk.querySelector('.tiers');
  const output = desk.querySelector('.output');
  const verdict = desk.querySelector('.desk-verdict');
  const details = desk.querySelector('.full-output');
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = 'Running public, edge, stress, perf...';
    tiers.innerHTML = ''; output.textContent = '';
    try {
      const response = await fetch('/api/grade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node: desk.dataset.node, source: desk.querySelector('.editor').value }),
      });
      const result = await response.json();
      tiers.innerHTML = result.tiers.map(t =>
        `<span class="tier ${t.outcome === 'pass' ? 'pass' : 'fail'}">${t.tier} - ${t.outcome}</span>`
      ).join('');
      status.textContent = result.ok ? 'All four tiers green.' : '';
      verdict.hidden = result.ok;
      verdict.innerHTML = result.ok ? '' :
        `<span class="mark">&#10007;</span> ` + escapeHtml(result.summary || `${result.stopped_at} is red.`);
      output.textContent = result.output || '';
      details.hidden = !result.output;
    } catch (error) { status.textContent = String(error); }
    finally { button.disabled = false; }
  };
});

// Inline exercises run in the reader's browser (Pyodide in a worker), never
// on the server: the published book has no /api/exec to fall back on.
const PYODIDE = 'https://cdn.jsdelivr.net/npm/pyodide@0.26.4/pyodide.js';
const WORKER = `importScripts('${PYODIDE}');
const ready = loadPyodide();
onmessage = async ({ data }) => {
  const py = await ready;
  let out = '', error = '';
  py.setStdout({ batched: s => { out += s + '\\n'; } });
  py.setStderr({ batched: s => { error += s + '\\n'; } });
  try {
    await py.runPythonAsync(data.source, { globals: py.globals.get('dict')() });
  } catch (err) {
    const lines = String(err.message).trim().split('\\n');
    const where = [...String(err.message).matchAll(/File "<exec>", line (\\d+)/g)].pop();
    error += (where ? 'Crashed on line ' + where[1] + ' · ' : '') + lines[lines.length - 1];
  }
  postMessage({ out, error });
};`;
let pyWorker = null;
function runInBrowser(source, timeout = 8000) {
  pyWorker ??= new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })));
  const worker = pyWorker;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      worker.terminate(); pyWorker = null;
      resolve({ out: '', error: 'Stopped after a few seconds: is there a loop that never ends?' });
    }, timeout);
    worker.onmessage = ({ data }) => { clearTimeout(timer); resolve(data); };
    worker.postMessage({ source });
  });
}
const tidy = text => text.replace(/^\n+|\n+$/g, '').split('\n').map(l => l.trimEnd()).join('\n').trimEnd();
const escapeHtml = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// Each line the exercise expects is one test, read like a grader's report.
function results(produced, expected, error) {
  const want = tidy(expected).split('\n');
  const got = tidy(produced) ? tidy(produced).split('\n') : [];
  const code = text => `<code>${escapeHtml(text)}</code>`;
  const rows = want.map((line, i) => {
    const ok = got[i] === line;
    const detail = ok ? code(line)
      : `expected ${code(line)} · got ${i < got.length ? code(got[i]) : 'nothing'}`;
    return { ok, html: `<li class="case ${ok ? 'pass' : 'fail'}"><span class="mark">${ok ? '&#10003;' : '&#10007;'}</span>`
      + `<span class="case-n">Test ${i + 1}</span><span>${detail}</span></li>` };
  });
  got.slice(want.length).forEach(line => rows.push({ ok: false, extra: true,
    html: `<li class="case fail"><span class="mark">&#10007;</span><span class="case-n">Extra</span>`
      + `<span>printed ${code(line)}, which no test asked for</span></li>` }));
  const passed = rows.filter(r => r.ok).length;
  const allOk = passed === want.length && rows.length === want.length && !error;
  const head = allOk
    ? `&#10003; All ${want.length} test${want.length > 1 ? 's' : ''} passed`
    : `&#10007; ${passed} of ${want.length} test${want.length > 1 ? 's' : ''} passed`;
  return { allOk, html: `<p class="results-head ${allOk ? 'pass' : 'fail'}">${head}</p>`
    + `<ol class="cases">${rows.map(r => r.html).join('')}</ol>`
    + (error ? `<pre class="case-error">${escapeHtml(error.trim())}</pre>` : '') };
}

document.querySelectorAll('.exercise').forEach(ex => {
  const button = ex.querySelector('.check');
  const status = ex.querySelector('.status');
  const panel = ex.querySelector('.results');
  if (!button) return; // the print edition shows exercises without a checker
  button.onclick = async () => {
    button.disabled = true; button.classList.add('busy');
    status.textContent = pyWorker ? 'Checking' : 'Loading Python, first time only';
    const { out, error } = await runInBrowser(ex.querySelector('.editor').value);
    const { allOk, html } = results(out, ex.dataset.expected, error);
    panel.hidden = false;
    panel.className = 'results ' + (allOk ? 'pass' : 'fail');
    panel.innerHTML = html;
    status.textContent = '';
    button.disabled = false; button.classList.remove('busy');
  };
});

// Hints live in the terminal. The bulb shows the next one; a read hint's dot
// shows it again. Spending is per challenge, for the session, and never falls.
document.querySelectorAll('.hint-panel').forEach(panel => {
  const desk = panel.closest('.desk');
  const button = desk.querySelector('.hint-button');
  const total = Number(panel.dataset.total);
  const key = 'hints:' + panel.dataset.ladder;
  let spent = 0;
  try { spent = Math.min(total, Number(JSON.parse(sessionStorage.getItem(key) || '0')) || 0); } catch {}
  let current = spent;
  const next = panel.querySelector('.hint-next');
  const paint = () => {
    if (button) button.querySelector('.hint-count').textContent = `${spent}/${total}`;
    panel.querySelectorAll('.hint-dot').forEach(dot => {
      const n = Number(dot.dataset.rung);
      dot.classList.toggle('spent', n <= spent);
      dot.classList.toggle('current', n === current);
      dot.disabled = n > spent;
      dot.setAttribute('aria-label', `Hint ${n}` + (n <= spent ? ', read' : ', not read yet'));
    });
    panel.querySelectorAll('.hint-body').forEach(body => { body.hidden = Number(body.dataset.rung) !== current; });
    const shown = panel.querySelector(`.hint-body[data-rung="${current}"]`);
    panel.querySelector('.hint-title').textContent = shown ? shown.dataset.title : '';
    next.hidden = spent >= total;
    next.textContent = spent ? 'Next hint' : 'Show hint 1';
  };
  const open = () => {
    panel.hidden = false;
    panel.style.animation = 'none'; void panel.offsetWidth; panel.style.animation = '';
    if (button) button.setAttribute('aria-expanded', 'true');
  };
  const spend = () => {
    if (spent < total) spent += 1;
    current = spent;
    try { sessionStorage.setItem(key, JSON.stringify(spent)); } catch {}
    paint(); open();
  };
  if (button) button.onclick = () => {
    if (!panel.hidden) { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); return; }
    if (!spent) spend(); else { current = current || spent; paint(); open(); }
  };
  next.onclick = spend;
  panel.querySelector('.hint-close').onclick = () => {
    panel.hidden = true; if (button) { button.setAttribute('aria-expanded', 'false'); button.focus(); }
  };
  panel.querySelectorAll('.hint-dot').forEach(dot => dot.onclick = () => {
    current = Number(dot.dataset.rung); paint(); open();
  });
  paint();
});

// Syntax colour, line numbers and indent guides: a highlighted copy of the
// code drawn under a transparent textarea, so editing stays native.
const KEYWORDS = new Set(('and as assert async await break continue del elif else except finally for '
  + 'from global if import in is lambda nonlocal not or pass raise return try while with yield').split(' '));
const DEFINERS = new Set(['def', 'class']);
const CONSTANTS = new Set(['True', 'False', 'None', 'self']);
const BUILTINS = new Set(('abs all any bool dict enumerate filter float int isinstance len list map max '
  + 'min print range reversed round set sorted str sum tuple type zip ValueError KeyError IndexError '
  + 'TypeError ZeroDivisionError Exception NotImplementedError input open iter next ord chr divmod').split(' '));
const TOKEN = /(#[^\n]*)|([rbfuRBFU]{0,2}(?:"{3}[\s\S]*?(?:"{3}|$)|'{3}[\s\S]*?(?:'{3}|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))|(@\w+)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_]\w*)/g;
const esc = text => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function highlight(source) {
  let html = '', last = 0, afterDef = false, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(source))) {
    html += esc(source.slice(last, m.index));
    const [text, com, str, dec, num, word] = m;
    let cls = com ? 'com' : str ? 'str' : dec ? 'dec' : num ? 'num' : '';
    if (word) {
      if (afterDef) cls = 'fn';
      else if (DEFINERS.has(word)) cls = 'def';
      else if (KEYWORDS.has(word)) cls = 'kw';
      else if (CONSTANTS.has(word)) cls = 'con';
      else if (BUILTINS.has(word)) cls = 'bi';
      else if (source[TOKEN.lastIndex] === '(') cls = 'fn';
      afterDef = DEFINERS.has(word);
    } else afterDef = false;
    html += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text);
    last = TOKEN.lastIndex;
  }
  html += esc(source.slice(last));
  return html.replace(/(^|\n)((?: {4})+)/g, (_, start, indent) =>
    start + '<span class="ig">    </span>'.repeat(indent.length / 4));
}

document.querySelectorAll('.editor').forEach(editor => {
  editor.setAttribute('wrap', 'off');
  const wrap = document.createElement('div');
  wrap.className = 'code-wrap';
  const hl = document.createElement('pre');
  hl.className = 'code-hl'; hl.setAttribute('aria-hidden', 'true');
  const gutter = document.createElement('pre');
  gutter.className = 'code-gutter'; gutter.setAttribute('aria-hidden', 'true');
  editor.replaceWith(wrap);
  wrap.append(gutter, hl, editor);
  const paint = () => {
    hl.innerHTML = highlight(editor.value) + '\n';
    const lines = editor.value.split('\n').length;
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  };
  const follow = () => {
    hl.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
    gutter.style.transform = `translateY(${-editor.scrollTop}px)`;
  };
  editor.addEventListener('input', paint);
  editor.addEventListener('scroll', follow);
  paint();
});

// The editors are plain textareas taught the four keys Python needs.
// Edits go through execCommand('insertText') so native undo stays one step.
const INDENT = '    ';
const DEDENTERS = /^\s*(return|pass|break|continue|raise)\b/;

function insert(editor, text, start, end) {
  editor.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    editor.setRangeText(text, start, end, 'end');
    editor.dispatchEvent(new Event('input'));
  }
}

function shiftLines(editor, outdent) {
  const { value, selectionStart: start, selectionEnd: end } = editor;
  const from = value.lastIndexOf('\n', start - 1) + 1;
  const stop = value.charAt(end - 1) === '\n' && end > start ? end - 1 : end;
  let to = value.indexOf('\n', stop);
  if (to === -1) to = value.length;
  const lines = value.slice(from, to).split('\n');
  const changed = lines.map(line => outdent
    ? line.replace(/^ {1,4}/, '')
    : (line.trim() || lines.length === 1 ? INDENT + line : line));
  const firstDelta = changed[0].length - lines[0].length;
  insert(editor, changed.join('\n'), from, to);
  const total = changed.join('\n').length - (to - from);
  editor.setSelectionRange(Math.max(from, start + firstDelta), end + total);
}

function runCell(editor, advance) {
  const holder = editor.closest('.cell-run, .desk, .exercise');
  const button = holder && holder.querySelector('.exec, .run, .check');
  if (!button) return;
  button.click();
  if (advance) {
    const editors = [...document.querySelectorAll('.editor')];
    const next = editors[editors.indexOf(editor) + 1];
    if (next) { next.focus(); next.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
}

document.querySelectorAll('.editor').forEach(editor => {
  let escaped = false;
  editor.addEventListener('keydown', event => {
    const { key, shiftKey } = event;
    const command = event.metaKey || event.ctrlKey;
    if (key === 'Escape') { escaped = true; return; }
    const leaving = escaped && key === 'Tab';
    escaped = false;
    if (leaving || event.isComposing) return;

    const { value, selectionStart: start, selectionEnd: end } = editor;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const before = value.slice(lineStart, start);

    if (key === 'Enter' && command) {
      event.preventDefault();
      runCell(editor, shiftKey);
    } else if (key === 'Enter') {
      event.preventDefault();
      let indent = (before.match(/^ */) || [''])[0];
      if (/:\s*$/.test(before)) indent += INDENT;
      else if (DEDENTERS.test(before)) indent = indent.slice(INDENT.length);
      insert(editor, '\n' + indent, start, end);
    } else if (key === 'Tab') {
      event.preventDefault();
      const multiline = value.slice(start, end).includes('\n');
      if (shiftKey || multiline) shiftLines(editor, shiftKey);
      else insert(editor, ' '.repeat(4 - (before.length % 4)), start, end);
    } else if (key === 'Backspace' && start === end && before.length && /^ +$/.test(before)) {
      event.preventDefault();
      const drop = before.length % 4 || 4;
      insert(editor, '', start - drop, start);
    }
  });
});

const drawer = document.querySelector('.drawer');
const scrim = document.querySelector('.scrim');
const contentsButton = document.querySelector('.contents-button');
const wide = () => window.matchMedia('(min-width: 1100px)').matches;

function setContents(open) {
  drawer.toggleAttribute('hidden', !open);
  scrim.toggleAttribute('hidden', !open);
  contentsButton.setAttribute('aria-expanded', String(open));
}

if (drawer && contentsButton) {
  setContents(false);
  contentsButton.onclick = () => setContents(drawer.hasAttribute('hidden'));
  scrim.onclick = () => setContents(false);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setContents(false); });
}

const scrollBar = document.querySelector('.scroll-progress i');
if (scrollBar) {
  const paintScroll = () => {
    const height = document.documentElement.scrollHeight - window.innerHeight;
    scrollBar.style.width = (height > 0 ? (window.scrollY / height) * 100 : 0) + '%';
  };
  document.addEventListener('scroll', paintScroll, { passive: true });
  paintScroll();
}
"""

MAP_SCRIPT = r"""
const MAP_COLOURS = {
  cleared: { bg: '#dcfce7', line: '#15803d', text: '#14532d' },
  open:    { bg: '#e0f2fe', line: '#0369a1', text: '#0c4a6e' },
  locked:  { bg: '#f1f1ef', line: '#9ca3af', text: '#4b5563' },
  empty:   { bg: '#fafaf8', line: '#d4d4d4', text: '#6b7280' },
};

const elements = JSON.parse(document.getElementById('map-data').textContent);
cytoscape.use(cytoscapeDagre);

const cy = cytoscape({
  container: document.getElementById('map'),
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
  const counts = { cleared: 0, open: 0, locked: 0, empty: 0 };
  cy.nodes().forEach(n => counts[n.data('state')]++);
  const open = cy.nodes().filter(n => n.data('state') === 'open')
    .map(n => `<a href="#" data-goto="${n.id()}">${n.data('label')}</a>`);
  detail.innerHTML = `
    <p class="rail-title">Where you are</p>
    <p class="detail-progress">${counts.cleared} cleared, ${counts.open} open now,
      ${counts.locked} waiting, ${counts.empty} not written yet</p>
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
        `<li><a href="/${n.id}">${n.title}</a> ${n.solved ? '<span class="tick">&#10003;</span>' : ''}` +
        `<span class="detail-kind">${n.kind}</span></li>`).join('') + '</ul>'
    : '<p class="detail-empty">Nothing written for this topic yet.</p>';
  detail.innerHTML = `
    <p class="detail-state ${d.state}">${states[d.state]}</p>
    <h2 class="detail-title">${d.label}</h2>
    <p class="detail-part">Part ${d.part} - ${d.partName}</p>
    <p class="detail-agent"><b>In the agent:</b> ${d.agent || '-'}</p>
    <p class="detail-progress">${d.total ? `${d.solved} of ${d.total} challenges solved` : ''}</p>
    <p class="rail-title">Needs first</p>${list(d.requires, 'Nothing - you can start here.')}
    <p class="rail-title">Unlocks</p>${list(d.unlocks, 'Nothing yet.')}
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
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quieter
        pass

    def _send(self, body: bytes, status=HTTPStatus.OK, kind="text/html; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        book, order = load_book()
        route = unquote(urlparse(self.path).path).strip("/")
        title = book.get("title", "Challenges")

        if route == "print":
            import epub as epub_tool

            inner = (
                '<h1>Print edition</h1><p class="lede">This is the EPUB\'s own markup, '
                'rendered here so you can read it without leaving the browser. '
                '<a href="/book.epub">Download the EPUB</a>.</p>'
                + epub_tool.print_preview()
            )
            chapters = "".join(
                f'<li><a href="#print-{html.escape(n["id"])}">'
                f'{html.escape(n["number"])} \u00b7 {html.escape(n["title"])}</a></li>'
                for n in order if n.get("number")
            )
            rail = f'<aside class="rail"><p class="rail-title">Chapters</p><ol class="rail-list">{chapters}</ol></aside>'
            return self._send(page("Print edition", inner, title, order, rail=rail))

        if route == "book.epub":
            import epub as epub_tool

            built = epub_tool.build()
            data = built.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/epub+zip")
            self.send_header("Content-Disposition", f'attachment; filename="{built.name}"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return None

        if route in ("map", "graph"):
            return self._send(page("The map", render_map(), title, order, wide=True))

        if not route:
            inner = (
                f'<h1>{html.escape(title)}</h1>'
                f'<p class="lede">{html.escape(book.get("subtitle", ""))}</p>'
                f'<p class="edition">Edition {html.escape(book.get("edition", ""))} · '
                f'{html.escape(book.get("author", ""))}</p>'
                f'{contents_html(order)}'
            )
            return self._send(page("Contents", inner, title, order))

        found = next((index for index, n in enumerate(order) if n["id"] == route), None)
        if found is None:
            return self._send(
                page("Not found", "<h1>Not found</h1>", title, order), HTTPStatus.NOT_FOUND
            )

        node = order[found]
        turn = '<nav class="turn">'
        turn += (
            f'<a href="/{order[found-1]["id"]}">‹ {html.escape(order[found-1]["title"])}</a>'
            if found > 0
            else "<span></span>"
        )
        turn += (
            f'<a href="/{order[found+1]["id"]}">{html.escape(order[found+1]["title"])} ›</a>'
            if found + 1 < len(order)
            else "<span></span>"
        )
        turn += "</nav>"
        return self._send(
            page(node["title"], render_node(node) + turn, title, order, node["id"], node)
        )

    def do_POST(self):
        route = urlparse(self.path).path
        if route == "/api/exec":
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            import subprocess
            import tempfile

            with tempfile.TemporaryDirectory() as work:
                script = Path(work) / "snippet.py"
                earlier = payload.get("earlier", [])
                own = payload.get("source", "")
                # Older callers may still send one combined prelude string.
                if isinstance(earlier, str):
                    earlier = [{"index": 1, "source": earlier}] if earlier.strip() else []
                # Earlier cells set the stage quietly. Keep their individual
                # failures so a failing current cell can identify broken context.
                runner = r'''import contextlib, io, traceback
def _run_cells(_earlier_cells, _own_source):
    _namespace = globals()
    _execute = exec
    _compile = compile
    _string_io = io.StringIO
    _redirect_stdout = contextlib.redirect_stdout
    _redirect_stderr = contextlib.redirect_stderr
    _format_exception = traceback.format_exc
    _first_earlier_failure = None
    for _cell in _earlier_cells:
        _quiet = _string_io()
        try:
            with _redirect_stdout(_quiet), _redirect_stderr(_quiet):
                _execute(_compile(_cell['source'], '<earlier cell>', 'exec'), _namespace, _namespace)
        except Exception:
            if _first_earlier_failure is None:
                _first_earlier_failure = (_cell, _format_exception())
    try:
        _execute(_compile(_own_source, '<current cell>', 'exec'), _namespace, _namespace)
    except Exception:
        if _first_earlier_failure is not None:
            _cell, _trace = _first_earlier_failure
            print(f"Earlier cell {_cell['index']} failed; shared state may be incomplete.")
            print('Source:\n' + _cell['source'])
            print(_trace)
        raise
'''
                runner += f"_run_cells({earlier!r}, {own!r})\n"
                script.write_text(runner)
                try:
                    done = subprocess.run(
                        [sys.executable, str(script)],
                        capture_output=True,
                        text=True,
                        timeout=15,
                        cwd=work,
                    )
                    output = (done.stdout + done.stderr).strip() or "(no output)"
                    ok = done.returncode == 0
                except subprocess.TimeoutExpired:
                    output, ok = "stopped after 15 seconds", False
            return self._send(
                json.dumps({"output": output, "ok": ok}).encode(), kind="application/json"
            )
        if route != "/api/grade":
            return self._send(b"{}", HTTPStatus.NOT_FOUND, "application/json")
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        node_id = payload.get("node", "")
        node_dir, meta = grader.load_node(node_id)

        workspace = grader.WORKSPACE_DIR / node_id
        workspace.mkdir(parents=True, exist_ok=True)
        (workspace / f"{meta['module']}.py").write_text(payload.get("source", ""))

        results, output, stopped_at, summary = [], "", None, ""
        for tier in grader.TIERS:
            config = meta.get("tiers", {}).get(tier, {})
            outcome, tier_output = grader.run_tier(
                node_dir, tier, workspace, config.get("timeout", 60)
            )
            results.append({"tier": tier, "outcome": outcome})
            if outcome != "pass":
                output, stopped_at = tier_output, tier
                summary = grader.summarize(tier_output, node_dir / "tests" / f"{tier}.py")
                break
        if stopped_at is None:
            progress = read_progress()
            if node_id not in progress.get("solved", []):
                progress.setdefault("solved", []).append(node_id)
                write_progress(progress)
        body = json.dumps(
            {"ok": stopped_at is None, "tiers": results, "stopped_at": stopped_at,
             # the reader needs the test's name and line, not this machine's folders
             "output": output.replace(str(WORKSPACE) + "/", "").replace(str(BOOKS) + "/", ""),
             "summary": summary if stopped_at else ""}
        ).encode()
        self._send(body, kind="application/json")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Reading at {url}  (Ctrl-C to stop)")
    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
