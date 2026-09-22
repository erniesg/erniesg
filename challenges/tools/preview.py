#!/usr/bin/env python3
"""Read the book locally, one column, exercises inline.

    python3 challenges/tools/preview.py [--port 8770] [--no-open]

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
    CHALLENGES,
    all_nodes,
    load_topics,
    CARD_BLOCKS,
    CONTENT_CSS,
    EDGE_KINDS,
    FIGURE_SCRIPT,
    PART_NAMES,
    WEB_FIGURE_CSS,
    all_nodes,
    figure as render_figure,
    load_book,
    load_node,
    load_topics,
    problem_card as render_problem_card,
    render_node,
    split_blocks,
)

CHALLENGES = Path(__file__).resolve().parent.parent
FIGURES = CHALLENGES / "figures"

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


PROGRESS_PATH = CHALLENGES / "workspace" / "progress.json"

HEADING = re.compile(r'<h2 id="([^"]+)">(.*?)</h2>')

STYLE = CONTENT_CSS + WEB_FIGURE_CSS + """
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
.toc-num { color:var(--dim); font-size:.78rem; font-variant-numeric:tabular-nums; }
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
.desk, .cell-run { margin:1.6rem 0; }
.editor { width:100%; min-height:190px; padding:12px; border:1px solid var(--line);
  border-radius:8px 8px 0 0; font:.86rem/1.5 ui-monospace,monospace; background:#15161a;
  color:#eee; resize:vertical; }
.editor.small { min-height:auto; height:auto; field-sizing:content; }
.desk-actions { display:flex; gap:12px; align-items:center; border:1px solid var(--line);
  border-top:0; border-radius:0 0 8px 8px; padding:8px 12px; background:#fff; }
.desk-actions button { font:600 .85rem ui-sans-serif,system-ui; padding:6px 14px; border:0;
  border-radius:6px; background:var(--accent); color:#fff; cursor:pointer; display:flex;
  align-items:center; gap:7px; }
.desk-actions kbd { font:.75rem ui-monospace,monospace; background:rgba(255,255,255,.22);
  padding:1px 5px; border-radius:4px; }
.editor:focus { outline:2px solid var(--accent); outline-offset:1px; }
.editor:focus + .desk-actions { border-color:var(--accent); }
.status { font:.8rem ui-sans-serif,system-ui; color:var(--dim); }
.tiers { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
.tier { font:.76rem ui-sans-serif,system-ui; padding:4px 10px; border-radius:20px;
  border:1px solid var(--line); background:#fff; }
.tier.pass { background:#dcfce7; border-color:#86efac; }
.tier.fail { background:#fee2e2; border-color:#fca5a5; }
.output:empty { display:none; }
.output { margin-top:10px; font-size:.8rem; white-space:pre-wrap; max-height:340px; overflow:auto; }
.cell-run .output:not(:empty) { margin-top:0; border-radius:0 0 8px 8px; }
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
        number = (
            f'<span class="toc-num">{html.escape(node["number"])}</span>'
            if node.get("number") else ""
        )
        tick = '<span class="toc-tick">\u2713</span>' if node.get("solved") else ""
        classes = "toc-row" + (" here" if node["id"] == current else "")
        return (
            f'<li class="{classes}"><a href="/{html.escape(node["id"])}">{number}'
            f'<span class="toc-title">{html.escape(node["title"])}</span>{tick}</a></li>'
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
        f'<li><a href="#{anchor}">{html.escape(re.sub("<[^>]+>", "", text))}</a></li>'
        for anchor, text in HEADING.findall(rendered)
    )
    blocks = ""
    if sections:
        blocks += f'<p class="rail-title">In this chapter</p><ol class="rail-list">{sections}</ol>'
    if node:
        nodes = all_nodes()
        links = ""
        for kind, (colour, label) in EDGE_KINDS.items():
            for target in node.get(kind, []):
                known = target in nodes
                name = nodes[target]["title"] if known else target.replace("-", " ")
                item = (
                    f'<a href="/{html.escape(target)}">{html.escape(name)}</a>'
                    if known
                    else f'<span class="planned">{html.escape(name)}</span>'
                )
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
         node: dict | None = None, wide: bool = False) -> bytes:
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
  <a class="graph-link" href="/print">Print</a>
  <div class="progress" title="{place} of {len(positions)} in this book">
    <div class="bar"><i style="width:{through}%"></i></div>
    <span class="progress-text">{place}/{len(positions)} · {solved}/{gradeable} solved</span>
  </div>
</header>
<div class="scrim" hidden></div>
<aside class="drawer" hidden><div class="drawer-inner">
  {contents_html(order, current)}
</div></aside>
<main class="{'wide' if wide else ''}"><article>{inner}</article>{render_rail(inner, node) if not wide else ''}</main>
<script>{SCRIPT}</script></body></html>""".encode()


SCRIPT = FIGURE_SCRIPT + r"""
const runnableCells = [...document.querySelectorAll('.cell-run')];
runnableCells.forEach((cell, index) => {
  const button = cell.querySelector('.exec');
  const status = cell.querySelector('.status');
  const output = cell.querySelector('.output');
  button.onclick = async () => {
    button.disabled = true; status.textContent = 'running...'; output.textContent = '';
    const earlier = runnableCells.slice(0, index)
      .map(c => c.querySelector('.editor').value).join('\n');
    try {
      const response = await fetch('/api/exec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: cell.querySelector('.editor').value, earlier }),
      });
      output.textContent = (await response.json()).output;
      status.textContent = '';
    } catch (error) { status.textContent = String(error); }
    finally { button.disabled = false; }
  };
});

document.querySelectorAll('.desk').forEach(desk => {
  const button = desk.querySelector('.run');
  const status = desk.querySelector('.status');
  const tiers = desk.querySelector('.tiers');
  const output = desk.querySelector('.output');
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
      status.textContent = result.ok ? 'All four tiers green.' : `${result.stopped_at} is red.`;
      output.textContent = result.output || '';
    } catch (error) { status.textContent = String(error); }
    finally { button.disabled = false; }
  };
});

// Cmd/Ctrl+Enter runs whichever editor has focus; Shift+Enter runs it and
// moves on to the next one, so you can walk a chapter from the keyboard.
document.querySelectorAll('.editor').forEach(editor => {
  editor.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey && !event.shiftKey)) return;
    const holder = editor.closest('.cell-run, .desk');
    const button = holder && holder.querySelector('.exec, .run');
    if (!button) return;
    event.preventDefault();
    button.click();
    if (event.shiftKey && !event.metaKey && !event.ctrlKey) {
      const editors = [...document.querySelectorAll('.editor')];
      const next = editors[editors.indexOf(editor) + 1];
      if (next) { next.focus(); next.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
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
            return self._send(page("Print edition", inner, title, order))

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
                earlier = payload.get("earlier", "")
                own = payload.get("source", "")
                # Earlier cells set the stage quietly: their prints are dropped
                # so the reader sees only what this cell produced.
                # Earlier cells set the stage and then get out of the way:
                # silent on both streams, and a deliberate raise up there must
                # not take this cell down (a chapter on errors has to show one).
                prelude = (
                    "import io, contextlib\n"
                    "_quiet = io.StringIO()\n"
                    "try:\n"
                    "    with contextlib.redirect_stdout(_quiet), contextlib.redirect_stderr(_quiet):\n"
                    "        exec(compile(_EARLIER, '<earlier cells>', 'exec'), globals())\n"
                    "except Exception:\n"
                    "    pass\n"
                )
                script.write_text(
                    f"_EARLIER = {earlier!r}\n{prelude if earlier.strip() else ''}{own}"
                )
                try:
                    done = subprocess.run(
                        [sys.executable, str(script)],
                        capture_output=True,
                        text=True,
                        timeout=15,
                        cwd=work,
                    )
                    output = (done.stdout + done.stderr).strip() or "(no output)"
                except subprocess.TimeoutExpired:
                    output = "stopped after 15 seconds"
            return self._send(
                json.dumps({"output": output}).encode(), kind="application/json"
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

        results, output, stopped_at = [], "", None
        for tier in grader.TIERS:
            config = meta.get("tiers", {}).get(tier, {})
            outcome, tier_output = grader.run_tier(
                node_dir, tier, workspace, config.get("timeout", 60)
            )
            results.append({"tier": tier, "outcome": outcome})
            if outcome != "pass":
                output, stopped_at = tier_output, tier
                break
        if stopped_at is None:
            progress = read_progress()
            if node_id not in progress.get("solved", []):
                progress.setdefault("solved", []).append(node_id)
                write_progress(progress)
        body = json.dumps(
            {"ok": stopped_at is None, "tiers": results, "output": output, "stopped_at": stopped_at}
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
