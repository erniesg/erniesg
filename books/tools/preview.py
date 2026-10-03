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
import os
import re
import sys
import threading
from datetime import datetime, timezone
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePath
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

if sys.version_info < (3, 11):
    sys.exit(f"This needs Python 3.11+; this is Python {sys.version.split()[0]}.")

import tomllib

import grade as grader
import progress as book_progress
from markdown import render_markdown
from manifest import topic_entries  # noqa: E402  (the map's topics, as the site gets them)
from render import (
    BOOKS,
    CHALLENGE_SPLIT_MIN_WIDTH,
    CHALLENGE_VIEW_HEAD_SCRIPT,
    SPLIT_CSS,
    SPLIT_SCRIPT,
    WORKSPACE,
    all_nodes,
    load_topics,
    CARD_BLOCKS,
    CONTENT_AT_RULES,
    CONTENT_CSS,
    MAP_AT_RULES,
    MAP_CSS,
    MAP_LIBRARIES,
    NAV_CSS,
    PART_NAMES,
    all_nodes,
    figure as render_figure,
    load_book,
    load_node,
    load_topics,
    map_markup,
    problem_card as render_problem_card,
    reading_navigation,
    render_node,
    section_headings,
    report_legacy_workspace,
    split_blocks,
)


BLOCK = re.compile(r"^:::(\w+)(\{[^}]*\})?\s*$", re.MULTILINE)
ATTR = re.compile(r'(\w+)\s*=\s*"?([^",}\s]+)"?')

def progress_book() -> str:
    """The book's url slug: the same key the published site stores progress under."""
    return str(load_book()[0].get("slug", ""))


def read_progress() -> dict:
    return book_progress.read_file(PROGRESS_PATH, progress_book())


def write_progress(progress: dict) -> None:
    book_progress.write_file(PROGRESS_PATH, progress)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# BOOK_PROGRESS_PATH lets a test run keep its own file, never the reader's.
PROGRESS_PATH = Path(os.environ.get("BOOK_PROGRESS_PATH") or WORKSPACE / "progress.json")
# The server is threaded: two saves at once must not interleave read and write.
PROGRESS_LOCK = threading.Lock()
# `runtime/*.mjs` is served as-is; the site bundles the same files.
RUNTIME = Path(__file__).resolve().parent / "runtime"
MAX_PROGRESS_BODY = 4 * 1024 * 1024

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
.print-page { border-bottom:1px solid var(--line); padding-bottom:2rem; margin-bottom:2rem; }
header.top .chapter-progress { max-width:34rem; margin:0 auto; }
article h2[id] { scroll-margin-top:64px; }
@media (max-width:1279px) { main { grid-template-columns:minmax(0,40rem); } .rail { display:none; } }
@media (max-width:760px) { header.top:has(.chapter-progress) :is(.book-title, .graph-link, .progress) { display:none; } }
@media (max-width:480px) { body { font-size:16px; } main { padding:20px 16px 60px; } }
:root { --split-top:45px; --split-surface:var(--bg); --split-ink:var(--ink); }
""" + SPLIT_CSS + (
    # Split covers the page below the top bar; the "Connected" rail under it
    # steps aside (the drawer and the map still reach it).
    "@media screen and (min-width:%dpx) {"
    ' html[data-challenge-view="split"] main:has([data-challenge-split]) > .rail'
    " { display:none; } }" % CHALLENGE_SPLIT_MIN_WIDTH
) + NAV_CSS + MAP_CSS + MAP_AT_RULES


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


def render_map() -> str:
    """The map, drawn by runtime/map.mjs: the same module and markup the site uses."""
    _, order = load_book()
    topics = topic_entries(order)
    solved = read_progress().get("solved", [])
    data = json.dumps({"topics": topics, "solved": solved}).replace("<", "\\u003c")
    return (
        map_markup()
        + f'<script id="map-data" type="application/json">{data}</script>'
        + "".join(f'<script src="{url}"></script>' for url in MAP_LIBRARIES)
        + "<script type=\"module\">import { drawMap } from '/runtime/map.mjs';"
        "const { topics, solved } = JSON.parse(document.getElementById('map-data').textContent);"
        "drawMap(document, { topics, solved, href: (id) => '/' + id });</script>"
    )


NAV_RUNTIME = Path(__file__).resolve().parent / "runtime" / "book-nav.mjs"


def nav_script() -> str:
    """The shortcuts and the live indicator: the site's module, inlined as-is."""
    return (
        f'<script type="module">{NAV_RUNTIME.read_text()}\n'
        "installBookKeys(document); trackChapterProgress(document);</script>"
    )


def page(title: str, inner: str, book_title: str, order: list[dict], current: str = "",
         node: dict | None = None, wide: bool = False, rail: str | None = None,
         progress: str = "") -> bytes:
    positions = [n["id"] for n in order]
    place = positions.index(current) + 1 if current in positions else 0
    solved = sum(1 for n in order if n.get("solved"))
    gradeable = sum(1 for n in order if n.get("kind") == "challenge")
    through = int(place / max(len(positions), 1) * 100)
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} — {html.escape(book_title)}</title><script>{CHALLENGE_VIEW_HEAD_SCRIPT}</script><style>{STYLE}</style></head>
<body>
<div class="scroll-progress"><i></i></div>
<header class="top">
  <button class="contents-button" aria-expanded="false">Contents</button>
  <a class="book-title" href="/">{html.escape(book_title)}</a>
  <a class="graph-link" href="/map">Map</a>
  <a class="graph-link" href="/print{'#print-' + html.escape(current) if current else ''}">Print</a>
  {progress}
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
<script>{SPLIT_SCRIPT}</script><script>{SCRIPT}</script>{nav_script() if progress else ''}
<script type="module">{PROGRESS_SCRIPT.replace("__BOOK__", json.dumps(progress_book()))}</script></body></html>""".encode()


SCRIPT = r"""
// Figures, cells, the desk and the hints live in runtime/interactive.mjs,
// shared with the published site.

// Editors (colour, line numbers, Python keys) live in runtime/editor.mjs,
// shared with the published site.

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

# Progress in the preview lives in books/workspace/progress.json, through
# /api/progress; the page code is the same module the published site runs.
PROGRESS_SCRIPT = r"""
import { startProgress } from '/runtime/book-progress.mjs';
import { wireEditors } from '/runtime/editor.mjs';
import { wireInteractive } from '/runtime/interactive.mjs';
// The preview runs the reader's code on this server: cells in a subprocess,
// challenges through grade.py.
const post = (route, body) => fetch(route, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(response => response.json());
wireInteractive(document, {
  exec: body => post('/api/exec', body),
  grade: body => post('/api/grade', body),
  sample: body => post('/api/sample', body),
});
wireEditors(document);
// Whether the last write reached the file, so the status never claims a save
// the server refused.
let saved = true;
startProgress({
  book: __BOOK__,
  backend: {
    async load() {
      try { const r = await fetch('/api/progress'); return r.ok ? await r.json() : {}; } catch { return {}; }
    },
    async save(progress) {
      const body = JSON.stringify(progress);
      try {
        // keepalive lets a save started as the page unloads still arrive; it
        // only takes small bodies, which every ordinary save is.
        const r = await fetch('/api/progress', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
          keepalive: body.length < 60000,
        });
        saved = r.ok;
        return r.ok ? await r.json() : null;
      } catch { saved = false; return null; }
    },
    describe: () => saved
      ? 'Saved to books/workspace/progress.json'
      : 'Not saved: the preview could not write books/workspace/progress.json.',
  },
});
"""





# How long one runnable cell may take on the local preview.
EXEC_TIMEOUT_SECONDS = 15

# One file for both hosts: the preview's subprocess and the site's Pyodide.
RUNNER = (Path(__file__).resolve().parent / "cell_runner.py").read_text()


def strip_roots(output: str, roots: tuple[PurePath, ...] | None = None) -> str:
    """Drop this machine's folders from grader output, on any separator.

    The reader needs the test's name and line, not where the book lives. The
    roots are matched with either separator after them, because a Windows
    path ends in a backslash and a forward-slash-only match left it whole.
    """
    for root in roots or (WORKSPACE, BOOKS):
        text = str(root)
        for spelling in {text, text.replace("\\", "/")}:
            for separator in ("/", "\\"):
                output = output.replace(spelling + separator, "")
    return output


def run_cell(earlier, own: str, timeout: float | None = None) -> dict:
    """Run one cell after the cells before it. Always `{"output", "ok"}`."""
    import tempfile

    # Older callers may still send one combined prelude string.
    if isinstance(earlier, str):
        earlier = [{"index": 1, "source": earlier}] if earlier.strip() else []
    limit = EXEC_TIMEOUT_SECONDS if timeout is None else timeout
    with tempfile.TemporaryDirectory() as work:
        script = Path(work) / "snippet.py"
        # Earlier cells set the stage quietly. Keep their individual failures
        # so a failing current cell can identify broken context.
        script.write_text(RUNNER + f"_run_cells({earlier!r}, {own!r})\n")
        # Bounded as it is written: a cell that prints in a loop must not hold
        # this server's memory for its whole time limit.
        code, stdout, stderr = grader.run_bounded([sys.executable, str(script)], limit, cwd=work)
        if code is None:
            return {"output": f"stopped after {limit:g} seconds", "ok": False}
    output = (stdout + stderr).strip() or "(no output)"
    return {"output": output, "ok": code == 0}


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

        if route == "api/progress":
            with PROGRESS_LOCK:
                body = json.dumps(read_progress()).encode()
            return self._send(body, kind="application/json")

        if route.startswith("runtime/"):
            name = route[len("runtime/"):]
            path = RUNTIME / name
            # Only the module files themselves: no subdirectories, no traversal.
            if "/" in name or not name.endswith(".mjs") or not path.is_file():
                return self._send(b"not found", HTTPStatus.NOT_FOUND, "text/plain")
            return self._send(path.read_bytes(), kind="text/javascript; charset=utf-8")

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
        body = render_node(node)
        rendered = {node["id"]: body}

        def sections(node_id: str) -> list[tuple[str, str]]:
            if node_id not in rendered:
                rendered[node_id] = render_node(next(n for n in order if n["id"] == node_id))
            return section_headings(rendered[node_id])

        nav = reading_navigation(
            order,
            node["id"],
            lambda node_id: f"/{node_id}",
            sections,
            frozenset(read_progress().get("solved", [])),
        )
        return self._send(
            page(node["title"], body + nav["pager"], title, order, node["id"], node,
                 progress=nav["progress"])
        )

    def do_POST(self):
        route = urlparse(self.path).path
        if route == "/api/exec":
            # Every response on this route carries a boolean `ok`: a clean run,
            # a raise, a timeout and a request that cannot be read alike. The
            # client's state machine must never have to guess from the text.
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError("the request body must be a JSON object")
            except (ValueError, UnicodeDecodeError) as error:
                return self._send(
                    json.dumps({"output": f"bad request: {error}", "ok": False}).encode(),
                    HTTPStatus.BAD_REQUEST,
                    "application/json",
                )
            result = run_cell(payload.get("earlier", []), payload.get("source", ""))
            return self._send(json.dumps(result).encode(), kind="application/json")
        if route == "/api/progress":
            # Merge, never overwrite: the browser may know solves this file does
            # not, and this file may know challenge solves the browser missed.
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length > MAX_PROGRESS_BODY:
                    raise ValueError("progress is larger than any book needs")
                payload = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError("the request body must be a JSON object")
            except (ValueError, UnicodeDecodeError) as error:
                return self._send(
                    json.dumps({"error": str(error)}).encode(), HTTPStatus.BAD_REQUEST, "application/json"
                )
            with PROGRESS_LOCK:
                merged = book_progress.merge(read_progress(), payload)
                write_progress(merged)
            return self._send(json.dumps(merged).encode(), kind="application/json")
        if route not in ("/api/grade", "/api/sample"):
            return self._send(b"{}", HTTPStatus.NOT_FOUND, "application/json")
        # The same contract as /api/exec: a request that cannot be graded still
        # answers with the shape the client reads, `ok` false and a reason.
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(payload, dict):
                raise ValueError("the request body must be a JSON object")
            node_id = str(payload.get("node", ""))
            node_dir, meta = grader.load_node(node_id)
        except (ValueError, UnicodeDecodeError, SystemExit, OSError, KeyError) as error:
            reason = f"cannot grade this request: {error}"
            return self._send(
                json.dumps({"ok": False, "tiers": [], "stopped_at": None,
                            "output": reason, "summary": reason}).encode(),
                HTTPStatus.BAD_REQUEST,
                "application/json",
            )

        workspace = grader.WORKSPACE_DIR / node_id
        workspace.mkdir(parents=True, exist_ok=True)
        (workspace / f"{meta['module']}.py").write_text(payload.get("source", ""))

        if route == "/api/sample":
            # Run is not grading: the statement's rows, every one of them, with
            # what each printed. Nothing here is ever recorded as solved.
            config = meta.get("tiers", {}).get(grader.SAMPLE_TIER, {})
            sample = grader.run_samples(node_dir, workspace, config.get("timeout", 60))
            return self._send(
                json.dumps({"ok": not sample["error"], "calls": sample["calls"],
                            "total": sample["total"],
                            "error": strip_roots(sample["error"])}).encode(),
                kind="application/json",
            )

        # The public tier's calls are always shown (they are the statement's
        # rows, where a reader's prints make sense); a failing tier's are shown
        # too, since the failing call is the one whose prints the reader needs.
        results, output, stopped_at, summary, cases = [], "", None, "", []
        for tier in grader.TIERS:
            config = meta.get("tiers", {}).get(tier, {})
            tier_calls: list[dict] = []
            counts: dict = {}
            outcome, tier_output = grader.run_tier(
                node_dir, tier, workspace, config.get("timeout", 60), calls=tier_calls, counts=counts
            )
            results.append({"tier": tier, "outcome": outcome})
            if tier_calls and (tier == grader.SAMPLE_TIER or outcome != "pass"):
                cases.append({"tier": tier, "outcome": outcome, "calls": tier_calls,
                              "total": counts.get("total", len(tier_calls))})
            if outcome != "pass":
                output, stopped_at = tier_output, tier
                summary = grader.summarize(tier_output, node_dir / "tests" / f"{tier}.py")
                break
        if stopped_at is None:
            with PROGRESS_LOCK:
                write_progress(book_progress.mark_solved(read_progress(), node_id, now_iso()))
        body = json.dumps(
            {"ok": stopped_at is None, "tiers": results, "stopped_at": stopped_at,
             # the reader needs the test's name and line, not this machine's folders
             "output": strip_roots(output),
             "cases": cases,
             "summary": summary if stopped_at else ""}
        ).encode()
        self._send(body, kind="application/json")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    report_legacy_workspace()

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
