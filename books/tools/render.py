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

# books/: one <book>.toml per book (title and reading order), and the pages
# any book can list: chapters/*.md and challenges/<id>/challenge.md. Figures,
# topics and tools are shared. workspace/ (attempts) and dist/ (EPUBs) are local.
BOOKS = Path(__file__).resolve().parent.parent
CHAPTERS = BOOKS / "chapters"
CHALLENGES = BOOKS / "challenges"
FIGURES = BOOKS / "figures"
WORKSPACE = BOOKS / "workspace"
DEFAULT_BOOK = "dsa"


def node_files() -> list[Path]:
    """Every chapter and every challenge, chapters first."""
    return sorted(CHAPTERS.glob("*.md")) + sorted(CHALLENGES.glob("*/challenge.md"))


# The collection every book belongs to: its name and author, not a book itself.
COLLECTION_FILE = BOOKS / "collection.toml"


def book_files() -> list[Path]:
    shared = ("topics.toml", COLLECTION_FILE.name)
    return sorted(p for p in BOOKS.glob("*.toml") if p.name not in shared)

BLOCK = re.compile(r"^:::(\w+)(\{[^}]*\})?\s*$", re.MULTILINE)
CLOSING = re.compile(r"^:::\s*$", re.MULTILINE)
ATTR = re.compile(r'(\w+)\s*=\s*"?([^",}\s]+)"?')
CARD_BLOCKS = ("statement", "io", "constraints", "sample")

# How much help a challenge comes with. A chapter ends with a ladder: the first
# problems are worked through, the last are yours alone.
SUPPORT_LEVELS = ("worked", "guided", "contract", "unaided")
# The page shows the hints and the solution itself, so a note only says what
# the page cannot: `unaided` is the check on whether the chapter stuck.
SUPPORT_NOTES = {
    "worked": "",
    "guided": "",
    "contract": "",
    "unaided": "No hints on this one, on purpose: it tells you whether the chapter stuck. "
               "The worked solution unlocks when all four tiers are green.",
}
RUNG_LABELS = ("a nudge", "a direction", "the shape of it", "most of the way")
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
# that only `books/tools/preview.py` can drive; every other kind is plain
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
    chapter = CHAPTERS / f"{node_id}.md"
    return chapter if chapter.is_file() else CHALLENGES / node_id / "challenge.md"


def load_node(node_id: str) -> dict:
    path = node_path(node_id)
    meta, body = read_front_matter(path)
    meta["body"] = body
    meta["dir"] = path.parent if path.name == "challenge.md" else None
    return meta


def all_nodes() -> dict[str, dict]:
    nodes = {}
    for path in node_files():
        try:
            meta, _ = read_front_matter(path)
        except ValueError:
            continue
        nodes[meta["id"]] = meta
    return nodes


def load_topics() -> dict[str, dict]:
    data = tomllib.loads((BOOKS / "topics.toml").read_text())
    return {topic["id"]: topic for topic in data.get("topic", [])}


def load_book(book_id: str = DEFAULT_BOOK) -> tuple[dict, list[dict]]:
    book = path = tomllib.loads((BOOKS / f"{book_id}.toml").read_text())
    order: list[dict] = []
    if path.get("front_matter"):
        node = load_node(path["front_matter"])
        node.update(part="", part_number="", number="")
        order.append(node)
    # Chapters are numbered through the whole book. A challenge is practice for
    # the chapter it follows: it takes no number of its own and sits under it.
    chapter_number = -1
    chapter: dict | None = None
    for part_index, part in enumerate(path.get("parts", [])):
        for node_id in part.get("nodes", []):
            node = load_node(node_id)
            node["part"] = part.get("title", "")
            node["part_number"] = str(part_index)
            if node.get("kind") == "challenge" and chapter is not None:
                chapter.setdefault("practice", []).append(node_id)
                node["number"] = ""
                node["chapter_number"] = chapter["number"]
                node["chapter_title"] = chapter["title"]
                node["practice_index"] = len(chapter["practice"])
            else:
                chapter_number += 1
                node["number"] = str(chapter_number)
                chapter = node
            order.append(node)
    for node in order:
        if node.get("chapter_number") is not None:
            owner = next(n for n in order if n.get("number") == node["chapter_number"])
            node["practice_total"] = len(owner.get("practice", []))
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
        f'<figcaption><span class="figure-title">{heading}</span>'
        f'<span class="figure-lead">{caption}</span></figcaption>{body}</figure>'
    )


def _figure_body(data: dict, kind: str, target: str) -> str:
    if kind == "cells":
        # A label and what it means, read down one column: code on the left.
        rows = "".join(
            f'<dt>{html.escape(str(cell.get("label", "")))}</dt>'
            f'<dd>{html.escape(str(cell.get("note", "")))}</dd>'
            for cell in data.get("cells", [])
        )
        return f'<dl class="pairs">{rows}</dl>'

    if kind == "walk":
        sequence = data.get("sequence", [])
        states = data.get("state", [])
        answer = data.get("answer") or {}
        notes = data.get("notes", [])
        # The answer is the end of the walk, so the web shows it only at the last step.
        tail = (
            f'<p class="figure-note walk-answer">{html.escape(str(answer.get("label", "")))}: '
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
                why = f" — {html.escape(str(notes[step]))}" if step < len(notes) else ""
                rows.append(f"<li>reading <b>{html.escape(str(value))}</b> → {snapshot}{why}</li>")
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
            f'<div class="walk-row">{items}</div>{rows}'
            + "".join(
                f'<p class="walk-note" data-index="{i}">{html.escape(str(n))}</p>'
                for i, n in enumerate(notes)
            )
            + f'{tail}'
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

    if node.get("chapter_number") is not None:
        emit(
            "eyebrow",
            f'<p class="eyebrow">Chapter {html.escape(node["chapter_number"])} \u00b7 '
            f'{html.escape(node["chapter_title"])} \u00b7 practice {node["practice_index"]} '
            f'of {node["practice_total"]}</p>',
        )
    elif node.get("number"):
        emit(
            "eyebrow",
            f'<p class="eyebrow">Part {html.escape(node["part_number"])} \u00b7 '
            f'{html.escape(node["part"])} \u00b7 Chapter {html.escape(node["number"])}</p>',
        )
    emit("title", f'<h1>{html.escape(node["title"])}</h1>')
    if node.get("kind") == "challenge":
        # Print has no grader either, and its reader is the same reader.
        note = SUPPORT_NOTES.get(support, "")
        if reveal == "reader" or target == "print":
            note = SUPPORT_NOTES_READER.get(support, note)
        if note:
            emit(
                "support",
                f'<p class="support support-{support}">{html.escape(note)}</p>',
            )
    hints: list[str] = []
    card_done = False

    def flush_hints() -> None:
        if not hints:
            return
        if target == "print":
            emit("hints", '<div class="hints">' + "".join(hints) + "</div>")
        elif not runnable:
            # A static host ships no script to open the hint panel, so the
            # hints stay plain disclosures there, as they are on main.
            emit(
                "hints",
                '<div class="hints">'
                + "".join(
                    f"<details class='hint'><summary>Hint {level}</summary>{body}</details>"
                    for level, body in hints
                )
                + "</div>",
            )
        else:
            button, panel = hint_controls(node["id"], hints)
            for index, piece in enumerate(out):
                if HINT_BUTTON in piece:
                    out[index] = piece.replace(HINT_BUTTON, button).replace(HINT_PANEL, panel)
                    break
            else:
                emit("hints", f'<div class="desk hint-only">{panel}</div>')
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
                hints.append((level, render_markdown(inner)))
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
                    "<details class='solution'><summary>Worked solution "
                    "<span class='rung-label'>the whole answer</span></summary>"
                    f"{render_markdown(inner)}</details>",
                )
        elif name == "run":
            emit("desk", _desk(node, attrs, target, runnable))
        elif name == "exercise":
            emit("exercise", exercise(attrs.get("id", ""), inner, target))
    flush_hints()
    return "".join(out).replace(HINT_BUTTON, "").replace(HINT_PANEL, "")


HINT_BUTTON = "<!--hint-button-->"
HINT_PANEL = "<!--hint-panel-->"
BULB = (
    '<svg class="bulb" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    '<path d="M8 1.5a4.5 4.5 0 0 0-2.6 8.2c.4.3.6.7.6 1.1V12h4v-1.2c0-.4.2-.8.6-1.1A4.5 4.5 0 0 0 8 1.5z'
    'M6 13.2h4M6.6 14.6h2.8" fill="none" stroke="currentColor" stroke-width="1.3" '
    'stroke-linecap="round"/></svg>'
)


def hint_controls(node_id: str, hints: list[tuple[str, str]]) -> tuple[str, str]:
    """A bulb in the action row, and the panel it opens inside the terminal.

    Each hint is spent once and stays readable: its dot fills, and clicking a
    filled dot shows that hint again. The count never falls.
    """
    total = len(hints)
    panel_id = f"hints-{html.escape(node_id)}"
    button = (
        f'<button type="button" class="hint-button" aria-expanded="false" '
        f'aria-controls="{panel_id}">{BULB}<span>Hint</span>'
        f'<span class="hint-count">0/{total}</span></button>'
    )
    dots = "".join(
        f'<button type="button" class="hint-dot" data-rung="{i + 1}" disabled '
        f'aria-label="Hint {i + 1}, not read yet"></button>'
        for i in range(total)
    )
    bodies = "".join(
        f'<div class="hint-body" data-rung="{i + 1}" '
        f'data-title="Hint {html.escape(level)} \u00b7 {html.escape(_rung_label(i, total))}" hidden>'
        f"{body}</div>"
        for i, (level, body) in enumerate(hints)
    )
    panel = (
        f'<div class="hint-panel" id="{panel_id}" data-ladder="{html.escape(node_id)}" '
        f'data-total="{total}" role="region" aria-label="Hints" hidden>'
        f'<div class="hint-bar"><span class="hint-dots">{dots}</span>'
        '<span class="hint-title"></span>'
        '<button type="button" class="hint-next">Next hint</button>'
        '<button type="button" class="hint-close" aria-label="Close hints">\u00d7</button></div>'
        f"{bodies}</div>"
    )
    return button, panel


def _rung_label(index: int, total: int) -> str:
    """Hint 1 nudges and the last hint nearly tells you; label the ladder so."""
    if total == 1:
        return RUNG_LABELS[0]
    return RUNG_LABELS[round(index * (len(RUNG_LABELS) - 1) / (total - 1))]


EXERCISE_FENCE = re.compile(r"^```(\w+)[^\n]*\n(.*?)^```\s*$", re.DOTALL | re.MULTILINE)
EXERCISE_PARTS = ("prompt", "starter", "output", "answer")


def parse_exercise(inner: str) -> dict:
    """Split an :::exercise into prompt, starter, expected output and answer.

    The prompt is the markdown before the first fence; the fences are named by
    their info string: ```python is the starter, ```output what it must print,
    ```answer the finished code. A part that is absent is simply missing from
    the result, so the validator can say which.
    """
    parts: dict = {}
    first = EXERCISE_FENCE.search(inner)
    prompt = inner[: first.start()] if first else inner
    if prompt.strip():
        parts["prompt"] = prompt.strip()
    names = {"python": "starter", "output": "output", "answer": "answer"}
    for match in EXERCISE_FENCE.finditer(inner):
        name = names.get(match.group(1))
        if name and name not in parts:
            parts[name] = match.group(2)
    return parts


def same_output(produced: str, expected: str) -> bool:
    tidy = lambda text: "\n".join(line.rstrip() for line in text.strip("\n").splitlines()).rstrip()
    return tidy(produced) == tidy(expected)


def exercise(exercise_id: str, inner: str, target: str) -> str:
    parts = parse_exercise(inner)
    missing = [name for name in EXERCISE_PARTS if name not in parts]
    if missing:
        return f'<p class="missing">exercise {html.escape(exercise_id)} is missing {", ".join(missing)}</p>'
    prompt = render_markdown(parts["prompt"])
    if target == "print":
        return (
            f'<section class="exercise" id="ex-{html.escape(exercise_id)}">'
            f'<p class="exercise-title">Try it</p>{prompt}'
            f'<pre><code>{html.escape(parts["starter"])}</code></pre>'
            f'<p class="figure-note">It should print:</p><pre><code>{html.escape(parts["output"])}</code></pre>'
            '<div class="solution"><p class="solution-title">Answer</p>'
            f'<pre><code>{html.escape(parts["answer"])}</code></pre></div></section>'
        )
    return (
        f'<section class="exercise" id="ex-{html.escape(exercise_id)}" '
        f'data-expected="{html.escape(parts["output"])}">'
        f'<p class="exercise-title">Try it</p>{prompt}'
        '<div class="exercise-run">'
        f'<textarea class="editor small" spellcheck="false">{html.escape(parts["starter"])}</textarea>'
        '<div class="desk-actions"><button class="check">Check <kbd>\u2318\u21b5</kbd></button>'
        f'<span class="status"></span>{KEYS_HINT}</div>'
        '<div class="results" role="status" hidden></div></div>'
        "<details class='answer'><summary>Show the answer</summary>"
        f'<pre><code>{html.escape(parts["answer"])}</code></pre></details></section>'
    )


RUNNABLE = re.compile(r'<pre><code class="language-python run">(.*?)</code></pre>', re.DOTALL)
GRADE_LINE = re.compile(r"^ *python3 books/tools/grade\.py \S+\n", re.MULTILINE)

KEYS_HINT = (
    '<span class="keys"><button type="button" class="keys-button" aria-label="Keyboard shortcuts">'
    '<svg viewBox="0 0 20 14" width="18" height="13" aria-hidden="true"><rect x=".75" y=".75" '
    'width="18.5" height="12.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/>'
    '<path d="M4 4.5h1.5M8 4.5h1.5M12 4.5h1.5M16 4.5h.5M4 7h1.5M8 7h1.5M12 7h1.5M16 7h.5M6 9.8h8" '
    'stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>'
    '<span class="keys-hint" role="note"><span class="keys-row"><span><kbd>Tab</kbd> / <kbd>\u21e7Tab</kbd></span>'
    '<span>indent / outdent</span></span>'
    '<span class="keys-row"><span><kbd>Esc</kbd> then <kbd>Tab</kbd></span><span>leave the editor</span></span>'
    '<span class="keys-row"><span><kbd>\u2318\u21b5</kbd></span><span>run</span></span>'
    '<span class="keys-row"><span><kbd>\u2318\u21e7\u21b5</kbd></span><span>run, then next editor</span></span>'
    '</span></span>'
)


def _runnable(rendered: str) -> str:
    """Only blocks the author marked ```python run get a Run button."""
    return RUNNABLE.sub(
        lambda m: (
            '<div class="cell-run">'
            f'<textarea class="editor small" spellcheck="false">{m.group(1)}</textarea>'
            '<div class="desk-actions"><button class="exec">Run <kbd>\u2318\u21b5</kbd></button>'
            f'<span class="status"></span>{KEYS_HINT}</div>'
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
    starter = GRADE_LINE.sub("    Press Run (\u2318\u21b5) to grade it.\n", starter)
    return (
        f'<section class="desk" data-node="{html.escape(node["id"])}">'
        f'<textarea class="editor" spellcheck="false">{html.escape(starter)}</textarea>'
        '<div class="desk-actions"><button class="run">Run all tiers <kbd>\u2318\u21b5</kbd></button>'
        f'{HINT_BUTTON}<span class="status"></span>{KEYS_HINT}</div>'
        f'{HINT_PANEL}<div class="tiers"></div><p class="desk-verdict" role="status" hidden></p>'
        '<details class="full-output" hidden><summary>Full test output</summary>'
        '<pre class="output"></pre></details></section>'
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
.figure-title { display:block; font:600 .8rem ui-sans-serif,system-ui; color:var(--ink); }
.figure-lead { display:block; margin:.2rem 0 .8rem; }
figcaption { font:.85rem/1.5 ui-sans-serif,system-ui; color:#555; margin:0; }
.figure-steps { font-size:.9rem; margin:.3rem 0 .3rem 1.1rem; }
.walk-note { font:.88rem/1.45 ui-sans-serif,system-ui; margin:.5rem 0 0; min-height:2.6em; }
.figure-note { font:.85rem ui-sans-serif,system-ui; color:var(--dim); margin:.4rem 0 0; }
.figure-table { margin-top:.6rem; font-size:.85rem; }
.links { width:100%; height:auto; }
.pairs { display:grid; grid-template-columns:minmax(8rem,max-content) 1fr; gap:6px 16px;
  margin:0; font:.9rem/1.45 ui-sans-serif,system-ui; }
.pairs dt { font:.84rem ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--ink); }
.pairs dd { margin:0; color:#444; }
@media (max-width:520px) { .pairs { grid-template-columns:1fr; } .pairs dd { margin-bottom:6px; } }
.hint, .solution { border:1px solid var(--line); border-radius:6px; padding:6px 12px; margin:8px 0;
  background:#fff; }
.desk-actions .hint-button { background:none; border:1px solid #4a4d57; color:#fcd34d; }
.desk-actions .hint-button[aria-expanded="true"] { background:#3a3320; border-color:#a16207; }
.hint-count { font:500 .75rem ui-sans-serif,system-ui; color:var(--term-dim); }
.hint-panel { border-top:1px solid var(--term-line); background:#26241d; color:#f3f0e6;
  padding:10px 14px 12px; font:.9rem/1.5 ui-sans-serif,system-ui; }
.hint-panel:not([hidden]) { animation:hint-in .35s ease-out; }
@keyframes hint-in { from { background:#4a3f16; opacity:.4; } to { background:#26241d; opacity:1; } }
@media (prefers-reduced-motion: reduce) { .hint-panel:not([hidden]) { animation:none; } }
.hint-bar { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.hint-dots { display:inline-flex; gap:6px; }
.hint-dot { width:12px; height:12px; padding:0; border-radius:50%; border:1.5px solid #a16207;
  background:none; cursor:pointer; }
.hint-dot:disabled { cursor:default; opacity:.6; }
.hint-dot.spent { background:#d97706; border-color:#d97706; }
.hint-dot.current { box-shadow:0 0 0 2px #26241d, 0 0 0 3.5px #fcd34d; }
.hint-dot:focus-visible { outline:2px solid #7dd3fc; outline-offset:2px; }
.hint-title { font-weight:600; color:#fcd34d; }
.hint-next, .hint-close { font:600 .78rem ui-sans-serif,system-ui; background:none; color:#f3f0e6;
  border:1px solid #57503a; border-radius:5px; padding:3px 9px; cursor:pointer; }
.hint-next { margin-left:auto; }
.hint-next[hidden] + .hint-close { margin-left:auto; }
.hint-close { font-size:1rem; line-height:1; padding:2px 8px; }
.hint-body p { margin:.2rem 0; max-width:none; }
.hint-body pre { background:#1a1914; font-size:.8rem; margin:.4rem 0 0; }
.hint-body code { background:#3a3628; color:inherit; }
.hint-body pre code { background:none; padding:0; }
.hint-only { padding:0; }
details.solution { border:0; border-top:2px solid var(--ink); border-radius:0; background:none;
  padding:10px 0 0; margin-top:1.4rem; }
.exercise { margin:1.8rem 0; padding:12px 16px 14px; border-left:4px solid #15803d;
  background:#f3faf5; border-radius:0 8px 8px 0; }
.exercise-title { font:700 .72rem/1 ui-sans-serif,system-ui; letter-spacing:.09em;
  text-transform:uppercase; color:#15803d; margin:0 0 .5rem; }
.exercise .answer { margin-top:.6rem; }
/* A runnable cell is one terminal: code, a hairline, the action row, output. */
.cell-run, .exercise-run, .desk { --term:#1e1f24; --term-line:#33353d; --term-ink:#d4d4d4;
  --term-dim:#a3a8b3; background:var(--term); border:1px solid #2b2d34; border-radius:8px;
  overflow:hidden; margin:1.6rem 0; }
.exercise-run { margin:.8rem 0 0; }
.code-wrap { position:relative; background:var(--term); overflow:hidden; }
.editor, .code-hl, .code-gutter { font:.86rem/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
  tab-size:4; white-space:pre; margin:0; }
.editor { display:block; width:100%; min-height:190px; padding:12px 12px 12px 3.6em; border:0;
  background:transparent; color:transparent; caret-color:#f5f5f5; resize:vertical;
  overflow:auto; position:relative; z-index:1; box-sizing:border-box; outline:none; }
.editor::selection { background:rgba(120,160,255,.35); color:transparent; }
.editor { field-sizing:content; }
.editor.small { min-height:auto; height:auto; }
.code-hl, .code-gutter { position:absolute; top:0; left:0; pointer-events:none; padding:0;
  background:none; border:0; border-radius:0; overflow:visible; }
.code-hl { padding:12px 12px 12px 3.6em; color:var(--term-ink); min-width:100%; box-sizing:border-box; }
.code-gutter { width:2.8em; padding:12px 0; text-align:right; color:#6b6f78; user-select:none; }
.code-hl .kw { color:#c586c0; } .code-hl .def { color:#569cd6; } .code-hl .fn { color:#dcdcaa; }
.code-hl .bi { color:#4ec9b0; } .code-hl .str { color:#ce9178; } .code-hl .num { color:#b5cea8; }
.code-hl .com { color:#6a9955; } .code-hl .con { color:#569cd6; } .code-hl .dec { color:#dcdcaa; }
.code-hl .ig { box-shadow:inset 1px 0 #3b3d44; }
.cell-run:focus-within, .exercise-run:focus-within, .desk:focus-within {
  border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
.desk-actions { display:flex; gap:12px; align-items:center; flex-wrap:wrap; padding:7px 12px;
  background:var(--term); border-top:1px solid var(--term-line); }
.code-wrap:focus-within + .desk-actions { border-top-color:var(--accent); }
.desk-actions button { font:600 .85rem ui-sans-serif,system-ui; padding:6px 14px; border:0;
  border-radius:6px; background:var(--accent); color:#fff; cursor:pointer; display:flex;
  align-items:center; gap:7px; }
.desk-actions button:focus-visible { outline:2px solid #7dd3fc; outline-offset:2px; }
.desk-actions button:disabled { cursor:progress; }
.desk-actions button.busy::after { content:""; width:10px; height:10px; border-radius:50%;
  border:2px solid rgba(255,255,255,.35); border-top-color:#fff; animation:spin .7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .desk-actions button.busy::after { animation:none; } }
.desk-actions kbd { font:.75rem ui-monospace,monospace; background:rgba(255,255,255,.22);
  padding:1px 5px; border-radius:4px; }
.status { font:.8rem ui-sans-serif,system-ui; color:var(--term-dim); }
.keys { position:relative; margin-left:auto; display:inline-flex; }
.desk-actions .keys-button { background:none; border:1px solid transparent; color:var(--term-dim);
  padding:4px 6px; border-radius:5px; }
.desk-actions .keys-button:hover, .keys:focus-within .keys-button { color:var(--term-ink);
  border-color:#444751; }
.keys-hint { display:none; position:absolute; right:0; bottom:calc(100% + 8px); z-index:5;
  background:#2b2d34; color:var(--term-ink); border:1px solid #444751; border-radius:8px;
  padding:8px 10px; font:.78rem ui-sans-serif,system-ui; white-space:nowrap;
  box-shadow:0 6px 18px rgba(0,0,0,.35); }
.keys:hover .keys-hint, .keys:focus-within .keys-hint { display:grid; gap:5px; }
.keys-row { display:grid; grid-template-columns:9.5em auto; align-items:center; gap:10px; }
.keys-row > span:last-child { color:var(--term-dim); }
.keys-hint kbd { font:.75rem ui-monospace,monospace; background:#1e1f24; border:1px solid #444751;
  border-radius:3px; padding:0 .3em; }
/* The terminal no longer clips, so the popover can rise over a short cell;
   its blocks are transparent so no square corner shows past the radius. */
.cell-run, .exercise-run, .desk { overflow:visible; }
.code-wrap, .desk-actions, .output { background:transparent; }
.code-wrap { border-radius:8px 8px 0 0; }
.desk:not(:has(.tiers:not(:empty), .desk-verdict:not([hidden]), .full-output:not([hidden]))) .hint-panel {
  border-radius:0 0 7px 7px; }
.desk-verdict { max-width:none; margin:0; padding:10px 14px; border-top:1px solid var(--term-line); color:#fca5a5;
  font:.9rem/1.45 ui-sans-serif,system-ui; }
.desk-verdict b { color:#fecaca; }
.full-output { border-top:1px solid var(--term-line); }
.full-output > summary { padding:8px 14px; color:var(--term-dim); font:600 .78rem ui-sans-serif,system-ui; }
.full-output .output { border-top:0; }
.output:empty { display:none; }
.output { margin:0; padding:10px 14px 12px; background:var(--term); color:var(--term-ink);
  border:0; border-top:1px solid var(--term-line); border-radius:0; font-size:.8rem;
  white-space:pre-wrap; max-height:340px; overflow:auto; }
.output::before { content:"Output"; display:block; font:600 .66rem ui-sans-serif,system-ui;
  letter-spacing:.08em; text-transform:uppercase; color:var(--term-dim); margin-bottom:4px; }
.output.error { box-shadow:inset 3px 0 #f87171; }
.output.error::before { content:"Error"; color:#fca5a5; }
.tiers:empty { display:none; }
.tiers { display:flex; gap:8px; flex-wrap:wrap; padding:10px 12px; border-top:1px solid var(--term-line); }
.tier { font:.76rem ui-sans-serif,system-ui; padding:4px 10px; border-radius:20px;
  border:1px solid var(--term-line); color:var(--term-ink); }
.tier.pass { color:#86efac; border-color:#166534; } .tier.pass::before { content:"✓ "; }
.tier.fail { color:#fca5a5; border-color:#7f1d1d; } .tier.fail::before { content:"✗ "; }
.results { padding:10px 14px 12px; border-top:1px solid var(--term-line); color:var(--term-ink);
  font:.84rem ui-sans-serif,system-ui; }
.results-head { margin:0 0 6px; font-weight:600; }
.results-head.pass { color:#86efac; } .results-head.fail { color:#fca5a5; }
.cases { list-style:none; margin:0; padding:0; }
.case { display:flex; gap:10px; align-items:baseline; padding:3px 0; max-width:none; }
.case .mark { width:1em; font-weight:700; }
.case.pass .mark { color:#86efac; } .case.fail .mark { color:#fca5a5; }
.case-n { color:var(--term-dim); min-width:3.6em; }
.case code { background:#2c2e35; color:var(--term-ink); }
.case-error { margin:8px 0 0; padding:8px 10px; background:#2a1d1f; color:#fecaca; border:0;
  border-radius:4px; font-size:.78rem; white-space:pre-wrap; }
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
