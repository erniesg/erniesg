#!/usr/bin/env python3
"""The one place a node becomes HTML.

Both the web edition (`preview.py`) and the print edition (`epub.py`) call
`render_node` here. Nothing else is allowed to emit block markup, because the
moment two renderers exist they drift, and the reader sees two different books.

The only difference between targets is what cannot cross:

    web    runnable cells, steppable figures, hints behind disclosure
    print  listings, the same figure states as a list, hints as sections

Stdlib only; needs Python 3.11+ for tomllib.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

if sys.version_info < (3, 11):
    sys.exit(f"This needs Python 3.11+; this is Python {sys.version.split()[0]}.")

import tomllib

from markdown import _inline, render_markdown

CHALLENGES = Path(__file__).resolve().parent.parent
FIGURES = CHALLENGES / "figures"

BLOCK = re.compile(r"^:::(\w+)(\{[^}]*\})?\s*$", re.MULTILINE)
CLOSING = re.compile(r"^:::\s*$", re.MULTILINE)
ATTR = re.compile(r'(\w+)\s*=\s*"?([^",}\s]+)"?')
CARD_BLOCKS = ("statement", "io", "constraints", "sample")

# How much help a challenge comes with. A chapter ends with a ladder: the first
# problems are worked through, the last are yours alone.
SUPPORT_LEVELS = ("worked", "guided", "contract", "unaided")
SUPPORT_NOTES = {
    "worked": "Worked through step by step, then hints, then the full solution.",
    "guided": "Hints if you want them, and a worked solution behind them.",
    "contract": "You get the contract and the tests. Hints are there; the "
                "solution waits until you pass.",
    "unaided": "No hints and no solution until every tier is green. This is "
               "the one that tells you whether it stuck.",
}
FIGURE_TYPES = ("cells", "walk", "links", "table", "cost")

# What a published page says instead, where the grader-facing note describes a
# gate that does not exist there. A static host has no tiers to turn green, so
# telling the reader the solution "waits until you pass" contradicts the
# disclosure holding it two lines below.
SUPPORT_NOTES_READER = {
    "contract": "You get the contract and the tests. The hints are here, and "
                "the worked solution is below when you want it.",
    # `validate.py` refuses a hint block on an unaided challenge, so this one
    # must not offer any: there is a worked solution below and nothing else.
    "unaided": "No hints on this one — that is what makes it the one that "
               "tells you whether it stuck. The worked solution is below, for "
               "after yours runs.",
}

# Figure kinds whose web body needs JavaScript. `walk` draws back/next buttons
# that only `challenges/tools/preview.py` can drive; every other kind is plain
# markup or a static SVG and survives on a host that ships no script.
CONTROLLED_FIGURES = ("walk",)

# The parts of the book, named once. The path files name the parts they walk;
# these cover the topics that are mapped but not yet written.
PART_NAMES = {
    0: "The loop", 1: "Programming basics", 2: "Lookup", 3: "Scanning",
    4: "Recursive structure", 5: "Graphs", 6: "Optimization",
    7: "The agent's structures", 8: "Engineering", 9: "At scale",
}

# A block wrapper the web edition emits and print does not: paper has no
# margin to anchor a note to. `BLOCK_TAG` is the one reader of what `emit`
# writes, so the two cannot drift.
BLOCK_TAG = re.compile(
    r'<div class="block" data-block-kind="([a-z-]+)" '
    r'data-block-digest="([0-9a-f]+)" id="([^"]+)">'
)


def block_id(node_id: str, kind: str, ordinal: int) -> str:
    """The DOM id a margin note anchors to.

    Structural, not content-derived, and not positional across kinds: the same
    source always yields the same id, and rewording a paragraph does not move
    the anchor off it.
    """
    return f"block-{node_id}-{kind}-{ordinal}"


# --------------------------------------------------------------------------
# loading
# --------------------------------------------------------------------------

def read_front_matter(path: Path) -> tuple[dict, str]:
    text = path.read_text()
    if not text.startswith("+++"):
        raise ValueError(f"{path} has no +++ front matter")
    _, raw, body = text.split("+++", 2)
    return tomllib.loads(raw), re.sub(r"\A\s*#\s+.*\n", "", body)


def node_path(node_id: str) -> Path:
    single = CHALLENGES / f"{node_id}.md"
    return single if single.is_file() else CHALLENGES / node_id / "challenge.md"


def load_node(node_id: str) -> dict:
    path = node_path(node_id)
    meta, body = read_front_matter(path)
    meta["body"] = body
    meta["dir"] = path.parent if path.name == "challenge.md" else None
    return meta


def all_nodes() -> dict[str, dict]:
    nodes = {}
    for path in sorted(CHALLENGES.glob("*.md")) + sorted(CHALLENGES.glob("*/challenge.md")):
        try:
            meta, _ = read_front_matter(path)
        except ValueError:
            continue
        nodes[meta["id"]] = meta
    return nodes


def load_topics() -> dict[str, dict]:
    data = tomllib.loads((CHALLENGES / "topics.toml").read_text())
    return {topic["id"]: topic for topic in data.get("topic", [])}


def load_book(path_id: str = "agent") -> tuple[dict, list[dict]]:
    book = tomllib.loads((CHALLENGES / "book.toml").read_text())
    path = tomllib.loads((CHALLENGES / "paths" / f"{path_id}.toml").read_text())
    # The path is the book: its title, subtitle and edition win.
    book = {**book, **{k: v for k, v in path.items() if k in ("title", "subtitle", "edition")}}
    order: list[dict] = []
    if path.get("front_matter"):
        node = load_node(path["front_matter"])
        node.update(part="", part_number="", number="")
        order.append(node)
    for part_index, part in enumerate(path.get("parts", [])):
        for index, node_id in enumerate(part.get("nodes", [])):
            node = load_node(node_id)
            node["part"] = part.get("title", "")
            node["part_number"] = str(part_index)
            node["number"] = f"{part_index}.{index + 1}"
            order.append(node)
    return book, order


def split_blocks(body: str) -> list[tuple[str, dict, str]]:
    pieces: list[tuple[str, dict, str]] = []
    position = 0
    while True:
        opening = BLOCK.search(body, position)
        if not opening:
            break
        if body[position : opening.start()].strip():
            pieces.append(("prose", {}, body[position : opening.start()]))
        closing = CLOSING.search(body, opening.end())
        pieces.append((
            opening.group(1),
            dict(ATTR.findall(opening.group(2) or "")),
            body[opening.end() : closing.start()] if closing else "",
        ))
        position = closing.end() if closing else len(body)
    if body[position:].strip():
        pieces.append(("prose", {}, body[position:]))
    return pieces


# --------------------------------------------------------------------------
# blocks
# --------------------------------------------------------------------------

def parse_io(inner: str) -> list[tuple[str, str]]:
    rows = []
    for line in inner.strip().splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            rows.append((key.strip().title(), value.strip()))
    return rows


def problem_card(node: dict, blocks: dict[str, str]) -> str:
    """The statement, laid out like a problem set: name, summary, in/out, rules."""
    statement = blocks.get("statement", "").strip().split("\n\n")
    summary = statement[0].replace("\n", " ").strip() if statement else ""
    rest = "\n\n".join(statement[1:])

    io_rows = "".join(
        f'<div class="io-row"><span class="io-key">{html.escape(key)}:</span> '
        f'<span class="io-value">{_inline(value)}</span></div>'
        for key, value in parse_io(blocks.get("io", ""))
    )
    limits = node.get("limits", {})
    limit_line = (
        f'<p class="labelled"><b>Limits.</b> '
        f'{html.escape(str(limits.get("time_seconds", "?")))} seconds, '
        f'{html.escape(str(limits.get("memory_mb", "?")))} MB.</p>'
        if limits
        else ""
    )
    constraints = blocks.get("constraints", "").strip()
    sample = blocks.get("sample", "").strip()
    return (
        f'<section class="problem"><p class="problem-name">{html.escape(node["title"])}</p>'
        f'<p class="problem-summary">{_inline(summary)}</p>{io_rows}</section>'
        f'{render_markdown(rest) if rest.strip() else ""}'
        + (f'<div class="labelled"><b>Constraints.</b>{render_markdown(constraints)}</div>'
           if constraints else "")
        + (f'<div class="labelled"><b>Sample.</b>{render_markdown(sample)}</div>'
           if sample else "")
        + limit_line
    )


def figure(
    figure_id: str,
    caption_override: str = "",
    target: str = "web",
    number: int | None = None,
    runnable: bool = True,
) -> str:
    """A figure, numbered so the prose can refer to it by name.

    A reader meeting a chart needs to know which figure it is and what it
    shows, in that order, without hunting for the sentence that introduced it.

    `runnable` is the host's, not the figure's: a static page ships no
    `data-walk` handler, so a steppable figure falls back to the print body
    rather than drawing buttons nothing listens to. It is the controller that
    is missing, not JavaScript in general, so only `CONTROLLED_FIGURES` fall
    back — the cost and links charts are static SVG and are fine as they are.
    """
    path = FIGURES / f"{figure_id}.json"
    if not path.is_file():
        return f'<p class="missing">missing figure: {html.escape(figure_id)}</p>'
    data = json.loads(path.read_text())
    kind = data.get("type")
    title = html.escape(data.get("title", ""))
    # the figure's own caption is what explains it; a directive's one-line
    # restatement is not a substitute for it, and printing both says it twice
    caption = html.escape(data.get("caption", "") or caption_override.strip())
    body_target = "print" if (not runnable and kind in CONTROLLED_FIGURES) else target
    body = _figure_body(data, kind, body_target)
    label = f"Figure {number}" if number else ""
    heading = f"{label} · {title}" if label and title else (label or title)
    return (
        f'<figure class="figure" id="figure-{html.escape(figure_id)}">'
        f'<p class="figure-title">{heading}</p>{body}'
        f"<figcaption>{caption}</figcaption></figure>"
    )


def _figure_body(data: dict, kind: str, target: str) -> str:
    if kind == "cells":
        cells = "".join(
            f'<div class="cell"><span class="cell-label">'
            f'{html.escape(str(cell.get("label", "")))}</span>'
            f'<span class="cell-note">{html.escape(str(cell.get("note", "")))}</span></div>'
            for cell in data.get("cells", [])
        )
        return f'<div class="cells">{cells}</div>'

    if kind == "walk":
        sequence = data.get("sequence", [])
        states = data.get("state", [])
        answer = data.get("answer") or {}
        tail = (
            f'<p class="figure-note">{html.escape(str(answer.get("label", "")))}: '
            f'<b>{html.escape(str(answer.get("value", "")))}</b></p>'
            if answer
            else ""
        )
        if target == "print":
            # No stepping on paper: show the same states as a numbered walk.
            rows = []
            for step, value in enumerate(sequence):
                snapshot = ", ".join(
                    f'{html.escape(str(s.get("label", "")))} = '
                    f'{html.escape(str(s.get("values", [])[step]))}'
                    for s in states
                    if step < len(s.get("values", []))
                )
                rows.append(f"<li>reading <b>{html.escape(str(value))}</b> → {snapshot}</li>")
            return f'<ol class="figure-steps">{"".join(rows)}</ol>{tail}'

        items = "".join(
            f'<span class="walk-item" data-index="{i}">{html.escape(str(v))}</span>'
            for i, v in enumerate(sequence)
        )
        rows = "".join(
            f'<div class="walk-state"><span class="walk-label">'
            f'{html.escape(str(state.get("label", "")))}</span>'
            + "".join(
                f'<span class="slot" data-step="{i}">{html.escape(str(v))}</span>'
                for i, v in enumerate(state.get("values", []))
            )
            + "</div>"
            for state in states
        )
        return (
            f'<div class="walk" data-steps="{len(sequence)}">'
            f'<div class="walk-row">{items}</div>{rows}{tail}'
            f'<div class="walk-controls"><button data-walk="back">‹ back</button>'
            f'<span class="walk-step">step <b>1</b> of {len(sequence)}</span>'
            f'<button data-walk="next">next ›</button></div></div>'
        )

    if kind == "cost":
        xs = data.get("x", {}).get("values", [])
        series = data.get("series", [])
        header = "".join(f"<th>{html.escape(str(x))}</th>" for x in xs)
        rows = "".join(
            f'<tr><td>{html.escape(str(item.get("label", "")))}</td>'
            + "".join(f"<td>{html.escape(str(v))}</td>" for v in item.get("values", []))
            + "</tr>"
            for item in series
        )
        # The same numbers in both editions; the web adds a drawing above them.
        table = (
            f'<table class="figure-table"><thead><tr>'
            f'<th>{html.escape(data.get("x", {}).get("label", ""))}</th>{header}</tr></thead>'
            f"<tbody>{rows}</tbody></table>"
        )
        if target == "print":
            return table
        peak = max((max(s.get("values", [0])) for s in series), default=1) or 1
        width, height = 520, 170
        colours = ["#c2410c", "#0369a1", "#15803d"]
        lines = ""
        for index, item in enumerate(series):
            points = " ".join(
                f"{30 + i * (width - 60) / max(len(xs) - 1, 1):.0f},"
                f"{height - 26 - (value / peak) * (height - 52):.0f}"
                for i, value in enumerate(item.get("values", []))
            )
            lines += (
                f'<polyline points="{points}" fill="none" '
                f'stroke="{colours[index % len(colours)]}" stroke-width="2"/>'
            )
        ticks = "".join(
            f'<text x="{30 + i * (width - 60) / max(len(xs) - 1, 1):.0f}" y="{height - 8}" '
            f'font-size="11" fill="#666" text-anchor="middle">{html.escape(str(x))}</text>'
            for i, x in enumerate(xs)
        )
        return (
            f'<svg viewBox="0 0 {width} {height}" class="cost" role="img">'
            f'<line x1="30" y1="{height - 26}" x2="{width - 30}" y2="{height - 26}" '
            f'stroke="#ccc"/>{lines}{ticks}</svg>{table}'
        )

    if kind == "table":
        header = data.get("header", [])
        rows = data.get("rows", [])
        head = "".join(f"<th>{html.escape(str(cell))}</th>" for cell in header)
        body_rows = "".join(
            "<tr>" + "".join(f"<td>{html.escape(str(cell))}</td>" for cell in row) + "</tr>"
            for row in rows
        )
        return (
            '<table class="figure-table">'
            + (f"<thead><tr>{head}</tr></thead>" if head else "")
            + f"<tbody>{body_rows}</tbody></table>"
        )

    if kind == "links":
        items = data.get("nodes", [])
        edges = data.get("edges", [])
        names = {item["id"]: item.get("label", item["id"]) for item in items}

        if target == "print":
            # Nothing moves on paper, so say the relationships in words.
            lines_out = "".join(
                f'<li>{html.escape(str(names.get(edge["from"], edge["from"])))} &#8594; '
                f'{html.escape(str(names.get(edge["to"], edge["to"])))}</li>'
                for edge in edges
            )
            return f'<ul class="figure-steps">{lines_out}</ul>'

        depth: dict[str, int] = {}
        incoming = {edge["to"] for edge in edges}
        for item in items:
            if item["id"] not in incoming:
                depth[item["id"]] = 0
        for _ in range(len(items)):
            for edge in edges:
                if edge["from"] in depth:
                    depth[edge["to"]] = max(depth.get(edge["to"], 0), depth[edge["from"]] + 1)

        columns: dict[int, list[str]] = {}
        for item in items:
            columns.setdefault(depth.get(item["id"], 0), []).append(item["id"])

        box_w, box_h, gap_x, gap_y = 130, 38, 60, 18
        place = {}
        for column, ids in columns.items():
            for index, node_id in enumerate(ids):
                place[node_id] = (10 + column * (box_w + gap_x), 10 + index * (box_h + gap_y))
        width = 20 + (max(columns) + 1) * (box_w + gap_x)
        height = 20 + max(len(ids) for ids in columns.values()) * (box_h + gap_y)

        drawn = "".join(
            f'<line x1="{place[e["from"]][0] + box_w}" y1="{place[e["from"]][1] + box_h / 2}" '
            f'x2="{place[e["to"]][0]}" y2="{place[e["to"]][1] + box_h / 2}" stroke="#94a3b8" '
            'stroke-width="1.5" marker-end="url(#link-arrow)"/>'
            for e in edges
            if e["from"] in place and e["to"] in place
        )
        boxes = "".join(
            f'<rect x="{x}" y="{y}" width="{box_w}" height="{box_h}" rx="7" fill="#fff" '
            f'stroke="#cbd5e1"/><text x="{x + box_w / 2}" y="{y + box_h / 2 + 4}" font-size="12" '
            f'text-anchor="middle" fill="#1a1a1a">{html.escape(str(names[node_id])[:18])}</text>'
            for node_id, (x, y) in place.items()
        )
        return (
            f'<svg viewBox="0 0 {width} {height}" class="links" role="img">'
            '<defs><marker id="link-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" '
            'orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#94a3b8"/></marker></defs>'
            f'{drawn}{boxes}</svg>'
        )

    return f'<p class="missing">no renderer for figure type {html.escape(str(kind))}</p>'


def render_node(
    node: dict,
    target: str = "web",
    solved: bool = False,
    runnable: bool = True,
    reveal: str = "grader",
) -> str:
    """One node, one markup, differing only where a target cannot follow.

    `solved` gates what a challenge is willing to show: an unaided problem
    keeps its solution until the tiers are green. Print shows everything,
    because a book cannot know who is reading it.

    `runnable` is what a web target can offer, not what it is. The local
    preview runs the reader's code in subprocesses; a static host cannot, so
    it asks for the same listings print gets rather than for dead buttons.

    `reveal` says who opens a hint or a solution. Under `"grader"` the tiers
    do, which is the local preview. Under `"reader"` the reader does, which is
    every published page: a static host has no grader, so gating on `solved`
    there does not defer a solution, it deletes it. Working through pseudocode,
    hints and a worked solution is what the book is for, so published pages
    keep all three behind a closed disclosure rather than behind a tier check
    that can never pass.
    """
    if reveal not in ("grader", "reader"):
        raise ValueError("reveal must be 'grader' or 'reader'")
    support = node.get("support", "guided")
    pieces = split_blocks(node["body"])
    card_parts = {name: inner for name, _, inner in pieces if name in CARD_BLOCKS}
    out: list[str] = []
    seen: dict[str, int] = {}

    def emit(kind: str, markup: str) -> None:
        """Append one addressable block.

        On the web each one carries a stable id, because the margin layer has
        to point at something that survives the next build. Print gets the
        same markup without the wrapper: a page has nowhere to put the note.
        """
        if target != "web":
            out.append(markup)
            return
        seen[kind] = seen.get(kind, 0) + 1
        # The id is positional, so inserting a block ahead of this one shifts
        # every later ordinal of the same kind. A note stored against the old
        # id would then resolve to a real element holding different content,
        # which is worse than not resolving at all. The digest is what lets a
        # resolver tell the two apart: same id and same digest is the same
        # block, same id and a different digest is drift to confirm, not to
        # silently follow.
        digest = hashlib.sha256(markup.encode("utf-8")).hexdigest()[:12]
        # Escaped even though `validate.py` restricts an id to a slug: this is
        # the attribute an annotation resolves through, and a value that can
        # close the attribute would take every note on the node with it.
        identifier = html.escape(block_id(node["id"], kind, seen[kind]), quote=True)
        out.append(
            f'<div class="block" data-block-kind="{kind}" '
            f'data-block-digest="{digest}" '
            f'id="{identifier}">{markup}</div>'
        )

    if node.get("part"):
        emit("eyebrow", f'<p class="eyebrow">{html.escape(node["part"])}</p>')
    emit("title", f'<h1>{html.escape(node["title"])}</h1>')
    if node.get("kind") == "challenge":
        # Print has no grader either, and its reader is the same reader.
        note = SUPPORT_NOTES.get(support, "")
        if reveal == "reader" or target == "print":
            note = SUPPORT_NOTES_READER.get(support, note)
        emit(
            "support",
            f'<p class="support support-{support}">{html.escape(note)}</p>',
        )
    hints: list[str] = []
    card_done = False

    def flush_hints() -> None:
        if hints:
            emit("hints", '<div class="hints">' + "".join(hints) + "</div>")
            hints.clear()

    figure_number = 0
    for name, attrs, inner in pieces:
        if name in CARD_BLOCKS:
            if not card_done:
                emit("card", problem_card(node, card_parts))
                card_done = True
            continue
        if name == "prose":
            rendered = render_markdown(inner)
            listing = target == "print" or not runnable
            emit("prose", rendered if listing else _runnable(rendered))
        elif name == "problem":
            referenced = load_node(attrs.get("id", ""))
            parts = {n: i for n, _, i in split_blocks(referenced["body"]) if n in CARD_BLOCKS}
            emit("card", problem_card(referenced, parts))
        elif name == "figure":
            figure_number += 1
            emit(
                "figure",
                figure(attrs.get("id", ""), inner, target, figure_number, runnable),
            )
        elif name == "hint":
            if support == "unaided" and target != "print" and reveal == "grader":
                continue
            level = html.escape(attrs.get("level", str(len(hints) + 1)))
            if target == "print":
                hints.append(
                    f'<div class="hint"><p class="hint-title">Hint {level}</p>'
                    f"{render_markdown(inner)}</div>"
                )
            else:
                hints.append(
                    f"<details class='hint'><summary>Hint {level}</summary>"
                    f"{render_markdown(inner)}</details>"
                )
        elif name == "solution":
            flush_hints()
            locked = (
                support in ("contract", "unaided")
                and not solved
                and reveal == "grader"
            )
            if locked and target != "print":
                emit(
                    "solution",
                    '<p class="locked-solution">The worked solution unlocks when all '
                    "four tiers are green.</p>",
                )
                continue
            if target == "print":
                emit(
                    "solution",
                    '<div class="solution"><p class="solution-title">Worked solution</p>'
                    f"{render_markdown(inner)}</div>",
                )
            else:
                emit(
                    "solution",
                    "<details class='solution'><summary>Worked solution — try a failing "
                    f"test first</summary>{render_markdown(inner)}</details>",
                )
        elif name == "run":
            emit("desk", _desk(node, attrs, target, runnable))
    flush_hints()
    return "".join(out)


RUNNABLE = re.compile(r'<pre><code class="language-python run">(.*?)</code></pre>', re.DOTALL)


def _runnable(rendered: str) -> str:
    """Only blocks the author marked ```python run get a Run button."""
    return RUNNABLE.sub(
        lambda m: (
            '<div class="cell-run">'
            f'<textarea class="editor small" spellcheck="false">{m.group(1)}</textarea>'
            '<div class="desk-actions"><button class="exec">Run <kbd>\u2318\u21b5</kbd></button>'
            '<span class="status"></span></div>'
            '<pre class="output"></pre></div>'
        ),
        rendered,
    )


def _desk(node: dict, attrs: dict, target: str, runnable: bool = True) -> str:
    starter = ""
    if node.get("dir"):
        path = node["dir"] / attrs.get("starter", "starter.py")
        if path.is_file():
            starter = path.read_text()
    if target == "print" or not runnable:
        # The same listing in both: a page cannot run code, and neither can a
        # static host. Where the EPUB shows a listing, so does the web.
        where = (
            "Run and grade this in the web edition, or from a "
            "terminal with the book's grader."
            if target == "print"
            else "Run and grade this from a terminal with the book's grader."
        )
        return (
            '<h2>Your turn</h2><pre><code>' + html.escape(starter) + "</code></pre>"
            f'<p class="figure-note">{where}</p>'
        )
    return (
        f'<section class="desk" data-node="{html.escape(node["id"])}">'
        f'<textarea class="editor" spellcheck="false">{html.escape(starter)}</textarea>'
        '<div class="desk-actions"><button class="run">Run all tiers <kbd>\u2318\u21b5</kbd></button>'
        '<span class="status">The first run is supposed to be red.</span></div>'
        '<div class="tiers"></div><pre class="output"></pre></section>'
    )


# --------------------------------------------------------------------------
# one stylesheet, shared
# --------------------------------------------------------------------------

CONTENT_CSS = """
:root { --ink:#1a1a1a; --dim:#666; --line:#e2e2e2; --accent:#0369a1; --bg:#fbfbf9; }
h1 { font-size:2rem; line-height:1.2; margin:0 0 1rem; }
h2 { font-size:1.35rem; margin:2.2rem 0 .6rem; }
h3 { font-size:1.08rem; margin:1.6rem 0 .4rem; }
p, li { max-width:36rem; }
code { font:.87em ui-monospace,SFMono-Regular,Menlo,monospace; background:#f0efe9;
  padding:.1em .3em; border-radius:3px; }
pre { background:#15161a; color:#eee; padding:14px 16px; border-radius:6px; overflow-x:auto; }
pre code { background:none; color:inherit; padding:0; }
blockquote { border-left:3px solid var(--accent); margin:1.2rem 0; padding:.2rem 0 .2rem 1rem; }
table { border-collapse:collapse; width:100%; font-size:.92rem; }
th, td { border:1px solid var(--line); padding:6px 9px; text-align:left; vertical-align:top; }
td code, th code { white-space:nowrap; }
.table-wrap { overflow-x:auto; margin:1rem 0; }
.eyebrow { font:600 .72rem/1 ui-sans-serif,system-ui; letter-spacing:.09em; text-transform:uppercase;
  color:var(--dim); margin:0 0 .5rem; }
.problem { border-top:1px solid var(--ink); border-bottom:1px solid var(--ink);
  padding:12px 0 14px; margin:1.6rem 0 1.2rem; }
.problem-name { font:600 1rem ui-sans-serif,system-ui; margin:0 0 .2rem; }
.problem-summary { margin:0 0 .7rem; font-style:italic; }
.io-row { margin:.15rem 0 .15rem 1.2rem; }
.io-key { font-weight:600; }
.labelled { margin:.9rem 0; }
.labelled > p:first-child { display:inline; }
.labelled b { margin-right:.35em; }
.labelled ul, .labelled ol { margin:.3rem 0 0; }
.figure { margin:1.8rem 0; padding:14px 16px; border:1px solid var(--line); border-radius:8px;
  background:#fff; }
.figure-title { font:600 .8rem ui-sans-serif,system-ui; margin:0 0 .6rem; }
figcaption { font:.82rem/1.5 ui-sans-serif,system-ui; color:var(--dim); margin-top:.7rem; }
.figure-steps { font-size:.9rem; margin:.3rem 0 .3rem 1.1rem; }
.figure-note { font:.85rem ui-sans-serif,system-ui; color:var(--dim); margin:.4rem 0 0; }
.figure-table { margin-top:.6rem; font-size:.85rem; }
.links { width:100%; height:auto; }
.cells { display:flex; gap:8px; flex-wrap:wrap; }
.cell { flex:1 1 120px; border:1px solid var(--line); border-radius:6px; padding:8px 10px;
  background:var(--bg); }
.cell-label { display:block; font:600 .85rem ui-sans-serif,system-ui; }
.cell-note { display:block; font:.76rem/1.4 ui-sans-serif,system-ui; color:var(--dim);
  margin-top:3px; }
.hint, .solution { border:1px solid var(--line); border-radius:6px; padding:6px 12px; margin:8px 0;
  background:#fff; }
.hint-title, .solution-title { font:600 .85rem ui-sans-serif,system-ui; margin:.2rem 0; }
details summary { cursor:pointer; font:600 .85rem ui-sans-serif,system-ui; }
.missing { color:#b91c1c; font:.85rem ui-sans-serif,system-ui; }
.support { font:.82rem/1.5 ui-sans-serif,system-ui; color:var(--dim); margin:-.4rem 0 1.2rem;
  padding-left:.7rem; border-left:3px solid var(--line); }
.support-worked { border-left-color:#15803d; }
.support-guided { border-left-color:#0369a1; }
.support-contract { border-left-color:#b45309; }
.support-unaided { border-left-color:#be185d; }
.locked-solution { font:.85rem ui-sans-serif,system-ui; color:var(--dim); border:1px dashed
  var(--line); border-radius:6px; padding:10px 12px; }
"""

PRINT_CSS = CONTENT_CSS + """
body { font-family: Georgia, serif; line-height:1.55; margin:0 6%; background:#fff; color:#111; }
h1 { font-size:1.6em; } h2 { font-size:1.2em; } h3 { font-size:1.02em; }
p, li { max-width:none; }
pre { background:#f4f4f1; color:#111; font-size:.82em; white-space:pre-wrap;
  word-wrap:break-word; border:1px solid #e4e4e0; }
.figure, .hint, .solution { background:#fff; }
"""
