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
from typing import Protocol

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
# Where attempts lived before the pool moved from challenges/ to books/. Git
# does not move an ignored folder, so a reader who pulls the rename still has
# their solutions and progress here until `migrate_legacy_workspace` runs.
LEGACY_WORKSPACE = BOOKS.parent / "challenges" / "workspace"


def migrate_legacy_workspace(
    legacy: Path = LEGACY_WORKSPACE, current: Path = WORKSPACE
) -> list[Path]:
    """Move a reader's pre-rename attempts to the current workspace, once.

    Every entry the new workspace lacks is moved across. `progress.json` in
    both is merged, so a challenge solved on either side stays solved. Any
    other entry present in both is left where it is and returned, so the
    caller can say so rather than overwrite a reader's work. Safe to call on
    every start: with nothing left at the old path it does nothing.
    """
    if not legacy.is_dir():
        return []
    current.mkdir(parents=True, exist_ok=True)
    left: list[Path] = []
    for entry in sorted(legacy.iterdir()):
        target = current / entry.name
        if not target.exists():
            entry.rename(target)
        elif entry.name == "progress.json" and entry.is_file():
            merged = {"solved": []}
            for source in (target, entry):
                try:
                    data = json.loads(source.read_text())
                except (OSError, json.JSONDecodeError):
                    continue
                if isinstance(data, dict):
                    for key, value in data.items():
                        if key != "solved":
                            merged.setdefault(key, value)
                    for node_id in data.get("solved", []):
                        if node_id not in merged["solved"]:
                            merged["solved"].append(node_id)
            target.write_text(json.dumps(merged, indent=2))
            entry.unlink()
        else:
            left.append(entry)
    if not left:
        legacy.rmdir()
        parent = legacy.parent
        try:
            parent.rmdir()  # only if the old pool folder is now empty
        except OSError:
            pass
    return left


def report_legacy_workspace() -> None:
    """Run the migration and say, on stderr, what could not be moved."""
    for entry in migrate_legacy_workspace():
        print(
            f"note: {entry} was left in place: {WORKSPACE / entry.name} already exists",
            file=sys.stderr,
        )


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

# What print says. Spec 066 drops the `worked` and `guided` notes on the web,
# where the hint bulb and the solution disclosure show the same thing; a page
# has neither, so print keeps a note for every level, as it did before 066.
# `contract` and `unaided` use the reader's wording: print has no grader.
SUPPORT_NOTES_PRINT = {
    "worked": "Worked through step by step, then hints, then the full solution.",
    "guided": "Hints if you want them, and a worked solution behind them.",
    **SUPPORT_NOTES_READER,
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

class RenderSource(Protocol):
    """Explicit data-only reads for the historical profile; no filesystem fallback."""

    def load_node(self, node_id: str) -> dict: ...
    def figure_data(self, figure_id: str) -> dict: ...
    def starter_text(self, node: dict, attrs: dict) -> str: ...


def parse_front_matter(text: str) -> tuple[dict, str]:
    """Canonical node parser, shared by filesystem and historical data readers."""
    if not text.startswith("+++"):
        raise ValueError("node has no +++ front matter")
    _, raw, body = text.split("+++", 2)
    return tomllib.loads(raw), re.sub(r"\A\s*#\s+.*\n", "", body)


def read_front_matter(path: Path) -> tuple[dict, str]:
    text = path.read_text()
    if not text.startswith("+++"):
        raise ValueError(f"{path} has no +++ front matter")
    return parse_front_matter(text)


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
    *,
    source: RenderSource | None = None,
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
    if source is None:
        path = FIGURES / f"{figure_id}.json"
        if not path.is_file():
            return f'<p class="missing">missing figure: {html.escape(figure_id)}</p>'
        data = json.loads(path.read_text())
    else:
        data = source.figure_data(figure_id)
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
    *,
    source: RenderSource | None = None,
    read_only: bool = False,
    max_output_bytes: int | None = None,
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
    if type(read_only) is not bool:
        raise ValueError("read_only must be a boolean")
    if source is not None and not read_only:
        raise ValueError("historical data requires the read-only profile")
    if max_output_bytes is not None and (
        type(max_output_bytes) is not int or max_output_bytes < 1 or not read_only
    ):
        raise ValueError("output budget requires the read-only profile and a positive integer")
    if read_only:
        runnable = False
        reveal = "reader"
    if reveal not in ("grader", "reader"):
        raise ValueError("reveal must be 'grader' or 'reader'")
    support = node.get("support", "guided")
    pieces = split_blocks(node["body"])
    card_parts = {name: inner for name, _, inner in pieces if name in CARD_BLOCKS}
    out: list[str] = []
    seen: dict[str, int] = {}
    emitted_bytes = 0

    def append(markup: str) -> None:
        nonlocal emitted_bytes
        if max_output_bytes is not None:
            emitted_bytes += len(markup.encode("utf-8"))
            if emitted_bytes > max_output_bytes:
                raise ValueError("historical output byte bound")
        out.append(markup)

    def emit(kind: str, markup: str) -> None:
        """Append one addressable block.

        On the web each one carries a stable id, because the margin layer has
        to point at something that survives the next build. Print gets the
        same markup without the wrapper: a page has nowhere to put the note.
        """
        if target != "web":
            append(markup)
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
        append(
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
        if target == "print":
            note = SUPPORT_NOTES_PRINT.get(support, note)
        elif reveal == "reader":
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
            referenced = (source.load_node(attrs.get("id", "")) if source is not None
                          else load_node(attrs.get("id", "")))
            parts = {n: i for n, _, i in split_blocks(referenced["body"]) if n in CARD_BLOCKS}
            emit("card", problem_card(referenced, parts))
        elif name == "figure":
            figure_number += 1
            emit(
                "figure",
                figure(attrs.get("id", ""), inner, target, figure_number, runnable, source=source),
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
            emit("desk", _desk(node, attrs, target, runnable, source=source))
        elif name == "exercise":
            emit("exercise", exercise(attrs.get("id", ""), inner, target, read_only=read_only))
    flush_hints()
    body = "".join(out)
    if node.get("kind") == "challenge" and target == "web" and not read_only:
        body = challenge_split(out)
    return body.replace(HINT_BUTTON, "").replace(HINT_PANEL, "")


def challenge_split(pieces: list[str]) -> str:
    """The challenge in two panes: the question, and the work.

    Everything before the desk is the question; the desk and everything after
    it (hints, the worked solution) is the work. Stacked, the two panes read in
    exactly the order the blocks were written, so the page is unchanged until
    the reader asks for the side-by-side view. The wrappers carry no block ids,
    so every margin anchor stays where it was.
    """
    desk = next(
        (i for i, piece in enumerate(pieces) if 'data-block-kind="desk"' in piece),
        None,
    )
    if desk is None:
        return "".join(pieces)
    return (
        '<div class="challenge-view" data-challenge-split>'
        f'<div class="split-toolbar">{VIEW_TOGGLE}</div>'
        '<div class="challenge-split">'
        '<div class="split-pane split-question" role="region" aria-label="The question">'
        f'{"".join(pieces[:desk])}</div>'
        '<div class="split-pane split-work" role="region" aria-label="Your code">'
        f'{"".join(pieces[desk:])}</div>'
        "</div></div>"
    )


# The reader's choice of view on a challenge page, remembered per browser.
# Both hosts (`preview.py` and the site) read the same key and attribute, and
# set the attribute before first paint so a remembered view never jumps.
CHALLENGE_VIEW_KEY = "book-challenge-view"
CHALLENGE_VIEW_ATTRIBUTE = "data-challenge-view"
# Narrower than this there is no room for two readable panes.
CHALLENGE_SPLIT_MIN_WIDTH = 1000

VIEW_TOGGLE = (
    '<button type="button" class="view-toggle" data-challenge-view-toggle '
    'aria-pressed="false" title="Show the question and the code side by side">'
    '<svg viewBox="0 0 18 14" width="16" height="13" aria-hidden="true">'
    '<rect x=".75" y=".75" width="16.5" height="12.5" rx="1.8" fill="none" '
    'stroke="currentColor" stroke-width="1.3"/>'
    '<path d="M9 1v12" stroke="currentColor" stroke-width="1.3"/></svg>'
    "<span>Side by side</span></button>"
)

# Before first paint. Anything but a stored "split" is the stacked default.
CHALLENGE_VIEW_HEAD_SCRIPT = (
    "try{if(localStorage.getItem('%s')==='split')"
    "document.documentElement.setAttribute('%s','split')}catch(e){}"
    % (CHALLENGE_VIEW_KEY, CHALLENGE_VIEW_ATTRIBUTE)
)


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


def exercise(exercise_id: str, inner: str, target: str, *, read_only: bool = False) -> str:
    parts = parse_exercise(inner)
    missing = [name for name in EXERCISE_PARTS if name not in parts]
    if missing:
        return f'<p class="missing">exercise {html.escape(exercise_id)} is missing {", ".join(missing)}</p>'
    prompt = render_markdown(parts["prompt"])
    if target == "print" or read_only:
        answer_open = ("<details class='answer'><summary>Show the answer</summary>"
                       if read_only and target == "web"
                       else '<div class="solution"><p class="solution-title">Answer</p>')
        answer_close = "</details>" if read_only and target == "web" else "</div>"
        return (
            f'<section class="exercise" id="ex-{html.escape(exercise_id)}">'
            f'<p class="exercise-title">Try it</p>{prompt}'
            f'<pre><code>{html.escape(parts["starter"])}</code></pre>'
            f'<p class="figure-note">It should print:</p><pre><code>{html.escape(parts["output"])}</code></pre>'
            f'{answer_open}<pre><code>{html.escape(parts["answer"])}</code></pre>{answer_close}</section>'
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

# A challenge desk has two runs. \u2318' is the sample run because it is the
# conventional "run" beside a "\u2318\u21b5 submit" in coding-practice sites, it
# needs no shift on any common layout, and nothing in the editor types it.
DESK_KEYS_HINT = KEYS_HINT.replace(
    '<span class="keys-row"><span><kbd>\u2318\u21b5</kbd></span><span>run</span></span>',
    "<span class=\"keys-row\"><span><kbd>\u2318'</kbd></span><span>run the samples</span></span>"
    '<span class="keys-row"><span><kbd>\u2318\u21b5</kbd></span><span>run all tiers</span></span>',
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


def _desk(node: dict, attrs: dict, target: str, runnable: bool = True, *,
          source: RenderSource | None = None) -> str:
    starter = ""
    if source is not None:
        starter = source.starter_text(node, attrs)
    elif node.get("dir"):
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
    starter = GRADE_LINE.sub(
        "    Press Run (\u2318') to try the samples, Run all tiers (\u2318\u21b5) to grade it.\n",
        starter,
    )
    return (
        f'<section class="desk" data-node="{html.escape(node["id"])}">'
        f'<textarea class="editor" spellcheck="false">{html.escape(starter)}</textarea>'
        '<div class="desk-actions">'
        '<button class="sample" title="Run your code on the statement\'s samples. Not graded.">'
        "Run <kbd>\u2318'</kbd></button>"
        '<button class="run">Run all tiers <kbd>\u2318\u21b5</kbd></button>'
        f'{HINT_BUTTON}<span class="status"></span>{DESK_KEYS_HINT}</div>'
        f'{HINT_PANEL}<div class="tiers"></div><p class="desk-verdict" role="status" hidden></p>'
        '<div class="cases" aria-live="polite"></div>'
        '<details class="full-output" hidden><summary>Test runner output</summary>'
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
/* A steppable figure, driven by runtime/interactive.mjs in every web edition. */
.walk-row, .walk-state { display:flex; gap:6px; align-items:center; margin:6px 0; }
.walk-item, .slot { min-width:34px; text-align:center; padding:5px 6px; border:1px solid var(--line);
  border-radius:5px; font:.9rem ui-monospace,monospace; background:var(--bg, #fbfbf9); }
.walk-item.on { background:#fde68a; border-color:#d97706; }
.walk-label { width:72px; font:.72rem ui-sans-serif,system-ui; color:var(--dim); }
.slot { visibility:hidden; }
.slot.on { visibility:visible; }
.walk-controls { display:flex; gap:10px; align-items:center; margin-top:10px;
  font:.8rem ui-sans-serif,system-ui; color:var(--dim); }
.walk-controls button { font:inherit; padding:3px 9px; border:1px solid var(--line);
  border-radius:5px; background:#fff; cursor:pointer; }
.figure-note { font:.85rem ui-sans-serif,system-ui; color:var(--dim); margin:.4rem 0 0; }
.figure-table { margin-top:.6rem; font-size:.85rem; }
.links { width:100%; height:auto; }
.pairs { display:grid; grid-template-columns:minmax(8rem,max-content) 1fr; gap:6px 16px;
  margin:0; font:.9rem/1.45 ui-sans-serif,system-ui; }
.pairs dt { font:.84rem ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--ink); }
.pairs dd { margin:0; color:#444; }
.hint, .solution { border:1px solid var(--line); border-radius:6px; padding:6px 12px; margin:8px 0;
  background:#fff; }
.desk-actions .hint-button { background:none; border:1px solid #4a4d57; color:#fcd34d; }
.desk-actions .hint-button[aria-expanded="true"] { background:#3a3320; border-color:#a16207; }
.hint-count { font:500 .75rem ui-sans-serif,system-ui; color:var(--term-dim); }
.hint-panel { border-top:1px solid var(--term-line); background:#26241d; color:#f3f0e6;
  padding:10px 14px 12px; font:.9rem/1.5 ui-sans-serif,system-ui; }
.hint-panel:not([hidden]) { animation:hint-in .35s ease-out; }
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
/* Marked by the page code once the reader has passed it, in any edition that runs it. */
.exercise.solved .exercise-title::after { content:" · solved ✓"; }
/* A runnable cell is one terminal: code, a hairline, the action row, output.
   It is dark on every page, so its colours do not follow the page's theme: a
   deep button fill that holds a white label, and a light focus ring that
   stands out against the terminal. */
.cell-run, .exercise-run, .desk { --term:#1e1f24; --term-line:#33353d; --term-ink:#d4d4d4;
  --term-dim:#a3a8b3; --term-button:#0369a1; --term-focus:#7dd3fc; background:var(--term); border:1px solid #2b2d34; border-radius:8px;
  overflow:hidden; margin:1.6rem 0; }
.exercise-run { margin:.8rem 0 0; }
/* The editor stacks its textarea over a highlighted copy (z-index 1). Each
   terminal isolates that, so it never paints above the page's own overlays,
   such as a popup drawn over the text from a neighbouring column. */
.cell-run, .exercise-run, .desk { isolation:isolate; }
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
  border-color:var(--term-focus); box-shadow:0 0 0 1px var(--term-focus); }
.desk-actions { display:flex; gap:12px; align-items:center; flex-wrap:wrap; padding:7px 12px;
  background:var(--term); border-top:1px solid var(--term-line); }
.code-wrap:focus-within + .desk-actions { border-top-color:var(--term-focus); }
.desk-actions button { font:600 .85rem ui-sans-serif,system-ui; padding:6px 14px; border:0;
  border-radius:6px; background:var(--term-button); color:#fff; cursor:pointer; display:flex;
  align-items:center; gap:7px; }
.desk-actions button:focus-visible { outline:2px solid #7dd3fc; outline-offset:2px; }
.desk-actions button:disabled { cursor:progress; }
.desk-actions button.busy::after { content:""; width:10px; height:10px; border-radius:50%;
  border:2px solid rgba(255,255,255,.35); border-top-color:#fff; animation:spin .7s linear infinite; }
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
.desk-actions .sample { background:none; border:1px solid var(--term-focus); color:var(--term-focus); }
.cases:empty { display:none; }
.cases { border-top:1px solid var(--term-line); padding:6px 0; color:var(--term-ink);
  font:.82rem ui-sans-serif,system-ui; }
.cases-head { margin:4px 14px 6px; color:var(--term-dim); font:600 .7rem ui-sans-serif,system-ui;
  letter-spacing:.06em; text-transform:uppercase; }
.call-case { display:block; margin:0 10px 8px; padding:8px 10px 8px 12px; border:1px solid var(--term-line);
  border-radius:6px; }
.call-case.bad { border-color:#7f1d1d; box-shadow:inset 3px 0 #f87171; }
.call-case.good { box-shadow:inset 3px 0 #22c55e; }
.case-call { font:.8rem ui-monospace,monospace; overflow-wrap:anywhere; }
.case-call .mark { margin-right:6px; }
.call-case.bad .mark { color:#fca5a5; } .call-case.good .mark { color:#86efac; }
.call-case.plain .mark { color:var(--term-dim); }
.case-got { margin-top:4px; font:.78rem ui-monospace,monospace; color:var(--term-dim); overflow-wrap:anywhere; }
.case-got b { color:var(--term-ink); font-weight:600; }
.case-prints > summary { margin-top:6px; color:var(--term-dim); font:600 .72rem ui-sans-serif,system-ui; cursor:pointer; }
.case-prints pre { margin:4px 0 0; padding:6px 8px; max-height:16rem; overflow:auto; white-space:pre-wrap;
  background:rgba(0,0,0,.25); border-radius:4px; color:var(--term-ink); font:.78rem/1.45 ui-monospace,monospace; }
.case-prints .dropped { color:var(--term-dim); font-style:italic; }
.case-none { margin-top:4px; color:var(--term-dim); font:italic .74rem ui-sans-serif,system-ui; }
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

# The site scopes CONTENT_CSS by selector prefix (`scopeContentCss` in
# src/lib/books.ts), and that refuses any at-rule it cannot scope safely. The
# at-rules live here instead, and every target that owns its whole document
# (the preview and the EPUB) appends them straight after CONTENT_CSS.
# The side-by-side view. Rooted on <html>, so a host includes it unscoped;
# `.challenge-view` exists only in a challenge's markup. Split, the view is a
# fixed layer from the host's top bar (`--split-top`, which the host sets) to
# the bottom of the window, and each pane is its own scroll container: the page
# itself does not scroll, so scrolling the question never moves the code and
# scrolling the code never moves the question.
SPLIT_CSS = """
.split-toolbar { display:flex; justify-content:flex-end; margin:0 0 .5rem; }
.view-toggle { display:inline-flex; align-items:center; gap:6px; padding:5px 10px;
  font:600 .75rem/1 ui-sans-serif,system-ui,sans-serif; color:inherit; background:transparent;
  border:1px solid color-mix(in srgb, currentColor 35%%, transparent); border-radius:6px;
  cursor:pointer; }
.view-toggle[aria-pressed="true"] { background:color-mix(in srgb, currentColor 12%%, transparent);
  border-color:currentColor; }
.view-toggle[aria-disabled="true"] { opacity:.5; cursor:not-allowed; }
.view-toggle:focus-visible { outline:2px solid #0369a1; outline-offset:2px; }
@media screen and (min-width:%(wide)spx) {
  html[data-challenge-view="split"]:has(.challenge-view),
  html[data-challenge-view="split"]:has(.challenge-view) body { overflow:hidden; }
  html[data-challenge-view="split"] .challenge-view { position:fixed; z-index:12;
    top:var(--split-top, 0px); left:0; right:0; bottom:0; display:grid;
    grid-template-rows:auto minmax(0,1fr); background:var(--split-surface, Canvas);
    color:var(--split-ink, CanvasText); padding:.6rem 1.5rem 0; }
  html[data-challenge-view="split"] .split-toolbar { margin:0 0 .6rem; }
  html[data-challenge-view="split"] .challenge-split { display:grid; min-height:0;
    grid-template-columns:minmax(0,1fr) minmax(0,1fr); column-gap:1.5rem; }
  html[data-challenge-view="split"] .split-pane { min-height:0; height:100%%; overflow-y:auto;
    overscroll-behavior:contain; padding:0 .75rem 2rem 0; }
  html[data-challenge-view="split"] .split-pane:focus-visible { outline:2px solid #0369a1;
    outline-offset:-2px; }
  html[data-challenge-view="split"] .split-work .desk .editor { min-height:45vh; }
}
""" % {"wide": CHALLENGE_SPLIT_MIN_WIDTH}

# The toggle's behaviour, for both hosts. Bound once per page lifetime (the
# site's client router re-runs inline scripts on every navigation) and synced
# again on each navigation. On the site it also folds the margin rail into its
# narrow-screen overlay while the two panes show: three columns do not fit,
# and the overlay keeps every annotation feature.
SPLIT_SCRIPT = r"""
(() => {
  const KEY = '%(key)s', ATTR = '%(attr)s', root = document.documentElement;
  const wide = window.matchMedia('(min-width: %(wide)spx)');
  const stored = () => {
    try { return localStorage.getItem(KEY) === 'split' ? 'split' : 'stacked'; }
    catch (e) { return 'stacked'; }
  };
  const sync = () => {
    const split = root.getAttribute(ATTR) === 'split';
    const room = wide.matches;
    const onChallenge = !!document.querySelector('[data-challenge-split]');
    // Split, each pane is a scroll container the keyboard can reach, so Page
    // Up/Down and Space scroll the pane that has focus and nothing else.
    document.querySelectorAll('.split-pane').forEach(pane => {
      if (split && room) pane.setAttribute('tabindex', '0');
      else pane.removeAttribute('tabindex');
    });
    document.querySelectorAll('[data-challenge-view-toggle]').forEach(button => {
      button.setAttribute('aria-pressed', String(split));
      button.setAttribute('aria-disabled', String(!room));
      button.title = !room ? 'Side by side needs a wider window'
        : split ? 'Show the question above the code'
        : 'Show the question and the code side by side';
    });
    // Split covers the page below the top bar, so what it covers leaves the tab
    // order and the accessibility tree: every sibling on the way up from the
    // view, except what stays drawn above it (a sticky or fixed bar that ends
    // above the panes, a drawer or overlay stacked over them, the margin).
    const view = document.querySelector('[data-challenge-split]');
    document.querySelectorAll('[data-split-inert]').forEach(element => {
      element.removeAttribute('inert');
      element.removeAttribute('data-split-inert');
    });
    if (view) view.style.removeProperty('--split-top');
    if (split && room && view) {
      const siblings = [];
      for (let node = view; node && node !== document.body; node = node.parentElement) {
        for (const sibling of node.parentElement ? node.parentElement.children : []) {
          if (sibling === node || /^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(sibling.tagName)) continue;
          siblings.push(sibling);
        }
      }
      // Top bars are pinned to the top of the window, possibly stacked: a site
      // header, then a bar pinned just under it (the chapter progress). The
      // view starts below the lowest bar of that stack, measured, so no bar is
      // ever partly covered, and every bar in it stays reachable.
      const candidates = siblings.filter(element => {
        const style = getComputedStyle(element);
        return (style.position === 'fixed' || style.position === 'sticky')
          && element.getBoundingClientRect().height < 200;
      }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const bars = [];
      let barBottom = 0;
      for (const element of candidates) {
        const box = element.getBoundingClientRect();
        if (box.top > barBottom + 1) break;
        bars.push(element);
        barBottom = Math.max(barBottom, box.bottom);
      }
      if (barBottom > 0) view.style.setProperty('--split-top', Math.ceil(barBottom) + 'px');
      const staysAbove = element => {
        if (bars.includes(element)) return true;
        if (element.matches('margin-rail') || element.querySelector('margin-rail')) return true;
        // A control the page marks as needed over the split view (edit mode's bar).
        if (element.matches('[data-split-keep]') || element.querySelector('[data-split-keep]')) return true;
        const style = getComputedStyle(element);
        return (style.position === 'fixed' || style.position === 'sticky') && Number(style.zIndex) > 12;
      };
      for (const sibling of siblings) {
        if (sibling.hasAttribute('inert') || staysAbove(sibling)) continue;
        sibling.setAttribute('inert', '');
        sibling.setAttribute('data-split-inert', '');
      }
    }
    document.querySelectorAll('margin-rail').forEach(rail => {
      if (!rail.hasAttribute('data-collapse-below-default')) {
        rail.setAttribute('data-collapse-below-default', rail.getAttribute('collapse-below') || '');
      }
      const base = rail.getAttribute('data-collapse-below-default');
      const next = split && room && onChallenge ? '100000' : base;
      if ((rail.getAttribute('collapse-below') || '') === next) return;
      if (next) rail.setAttribute('collapse-below', next);
      else rail.removeAttribute('collapse-below');
    });
  };
  if (!root.hasAttribute(ATTR)) root.setAttribute(ATTR, stored());
  if (!window.__challengeViewBound) {
    window.__challengeViewBound = true;
    document.addEventListener('click', event => {
      const button = event.target instanceof Element
        && event.target.closest('[data-challenge-view-toggle]');
      if (!button || button.getAttribute('aria-disabled') === 'true') return;
      const next = root.getAttribute(ATTR) === 'split' ? 'stacked' : 'split';
      root.setAttribute(ATTR, next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* this page only */ }
      sync();
    });
    wide.addEventListener('change', sync);
    document.addEventListener('astro:page-load', sync);
  }
  sync();
})();
""" % {"key": CHALLENGE_VIEW_KEY, "attr": CHALLENGE_VIEW_ATTRIBUTE, "wide": CHALLENGE_SPLIT_MIN_WIDTH}


CONTENT_AT_RULES = """
@media (max-width:520px) { .pairs { grid-template-columns:1fr; } .pairs dd { margin-bottom:6px; } }
@keyframes hint-in { from { background:#4a3f16; opacity:.4; } to { background:#26241d; opacity:1; } }
@media (prefers-reduced-motion: reduce) { .hint-panel:not([hidden]) { animation:none; } }
@keyframes spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .desk-actions button.busy::after { animation:none; } }
"""

# The book's map (runtime/map.mjs draws it): every topic, what it needs first,
# and where the reader stands. The preview serves it at /map, the site at
# /books/<slug>/map/; both draw the same markup with the same stylesheet.
# Each pinned to its exact bytes (Subresource Integrity): a CDN that served
# anything else would have it refused, not run with the page's privileges.
# Changing a version means recomputing its hash (sha384, base64).
MAP_LIBRARIES = (
    {
        "url": "https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js",
        "integrity": "sha384-IWROdLKRsN1UuJywMlWl7/blXQ8GEooN2n7dzTxfEPd7ybYIKCUJ2Ol/1Gpf3YV4",
    },
    {
        "url": "https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js",
        "integrity": "sha384-2IH3T69EIKYC4c+RXZifZRvaH5SRUdacJW7j6HtE5rQbvLhKKdawxq6vpIzJ7j9M",
    },
    {
        "url": "https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js",
        "integrity": "sha384-EHCdyFVbhtbpgI+4x7ETlZUvJwOkxJublmhTpH114NSk3fqfiUgcLl6pQm8JQwg9",
    },
)

MAP_CSS = """
.map-title { font-size:2rem; font-weight:700; line-height:1.2; margin:0 0 .5rem; }
.map-lede { font-size:1.05rem; line-height:1.55; margin:0 0 .4rem; color:var(--dim, #666); }
.map-counts { font:.85rem ui-sans-serif,system-ui; color:var(--dim, #666); margin:0; }
.map-topics { margin-top:1.6rem; font:.87rem/1.5 ui-sans-serif,system-ui; }
.map-topics-title { font:600 1rem ui-sans-serif,system-ui; margin:0 0 .4rem; }
.map-topics-part { font:600 .68rem ui-sans-serif,system-ui; letter-spacing:.09em; text-transform:uppercase;
  color:var(--dim, #666); margin:1rem 0 .3rem; }
.map-topics ul { list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:6px; }
.map-topics button { font:inherit; padding:4px 9px; border:1px solid var(--line, #e2e2e2); border-radius:6px;
  background:transparent; color:inherit; cursor:pointer; }
.map-topics button:hover, .map-topics button[aria-current="true"] { border-color:var(--ink, #1a1a1a); }
.map-topics button:focus-visible { outline:2px solid var(--accent, #0369a1); outline-offset:2px; }
.map-topic-state { margin-left:.4rem; color:var(--dim, #666); font-size:.75rem; }
.map-detail:focus { outline:none; }
.map-detail:focus-visible { outline:2px solid var(--accent, #0369a1); outline-offset:2px; }
.map-detail .rail-title { font:600 .68rem ui-sans-serif,system-ui; letter-spacing:.09em;
  text-transform:uppercase; color:var(--dim); }
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
"""

# Kept apart, as CONTENT_AT_RULES is: the site scopes MAP_CSS by selector
# prefix, which an at-rule would defeat. `.map-wrap` exists only on the map.
MAP_AT_RULES = """
@media (max-width:1100px) { .map-wrap { grid-template-columns:minmax(0,1fr); } }
"""


def map_markup() -> str:
    """The map page's body. The counts line and the panel fill in from progress."""
    return '''<h1 class="map-title">The map</h1>
<p class="lede map-lede">Every topic in the book and what it needs first. Click one to see
what it unlocks and what is written for it.</p>
<p class="edition map-counts" data-map-counts></p>
<div class="map-tools">
  <input id="map-search" type="search" placeholder="Find a topic" autocomplete="off" aria-label="Find a topic">
  <span class="legend-item"><i class="swatch cleared"></i>cleared</span>
  <span class="legend-item"><i class="swatch open"></i>open now</span>
  <span class="legend-item"><i class="swatch locked"></i>locked</span>
  <span class="legend-item"><i class="swatch empty"></i>not written</span>
</div>
<div class="map-wrap"><div class="map-stage"><div id="map"></div>
  <div class="map-controls">
    <button type="button" data-zoom="in" title="Zoom in">+</button>
    <button type="button" data-zoom="out" title="Zoom out">−</button>
    <button type="button" data-zoom="fit" title="Fit to screen">Fit</button>
    <button type="button" data-zoom="reset" title="Back to the start">Reset</button>
  </div></div><aside id="map-detail" class="map-detail" tabindex="-1" aria-live="polite"></aside></div>
<nav class="map-topics" aria-labelledby="map-topics-title">
  <h2 id="map-topics-title" class="map-topics-title">All topics</h2>
  <div id="map-topics"></div>
</nav>'''


PRINT_CSS = CONTENT_CSS + CONTENT_AT_RULES + """
body { font-family: Georgia, serif; line-height:1.55; margin:0 6%; background:#fff; color:#111; }
h1 { font-size:1.6em; } h2 { font-size:1.2em; } h3 { font-size:1.02em; }
p, li { max-width:none; }
pre { background:#f4f4f1; color:#111; font-size:.82em; white-space:pre-wrap;
  word-wrap:break-word; border:1px solid #e4e4e0; }
.figure, .hint, .solution { background:#fff; }
"""


# ---------------------------------------------------------------------------
# Reading order: the pager at the end of a node, and the chapter progress
# indicator every surface keeps in view. One author for both, like the block
# markup: the preview and the site hand these strings over verbatim and supply
# only how a node id becomes a URL. `books/tools/runtime/book-nav.mjs` is the
# behaviour (shortcuts, the section in view, solved ticks); it reads these
# attributes and nothing else.

NAV_SECTION = re.compile(r'<h2 id="([^"]+)">(.*?)</h2>', re.DOTALL)
_NAV_TAGS = re.compile(r"<[^>]+>")


def section_headings(markup: str) -> list[tuple[str, str]]:
    """The sections of one rendered node: its h2s, as (anchor, plain text)."""
    return [
        (anchor, html.unescape(_NAV_TAGS.sub("", text)).strip())
        for anchor, text in NAV_SECTION.findall(markup)
    ]


def chapter_of(order: list[dict], node_id: str) -> dict | None:
    """The numbered chapter a node belongs to.

    A chapter is itself; a practice challenge belongs to the chapter it
    follows (`load_book` records that as `chapter_number`); the front matter
    belongs to none.
    """
    node = next((n for n in order if n["id"] == node_id), None)
    if node is None:
        return None
    number = node.get("chapter_number")
    if number is None:
        return node if node.get("number") else None
    return next((n for n in order if n.get("number") == number), None)


def _nav_link(rel: str, target: dict, url: str) -> str:
    direction = "← Previous" if rel == "prev" else "Next →"
    return (
        f'<a class="pager-{rel}" rel="{rel}" href="{html.escape(url)}" data-book-{rel}>'
        f'<span class="pager-dir">{direction}</span>'
        f'<span class="pager-title">{html.escape(target["title"])}</span></a>'
    )


def nav_status(kind: str, section: int, sections: int, practice: int, total: int,
               solved: int) -> str:
    """The indicator's words. `book-nav.mjs` writes the same ones as they change."""
    parts: list[str] = []
    if kind == "concept" and sections:
        parts.append(f"Section {section} of {sections}")
    if kind == "challenge":
        parts.append(f"Practice {practice} of {total}")
    if total:
        lead = "practice " if kind == "concept" and sections else ""
        parts.append(f"{lead}{solved}/{total} solved")
    return " · ".join(parts)


def reading_navigation(
    order: list[dict],
    node_id: str,
    href,
    sections,
    solved=frozenset(),
) -> dict[str, str]:
    """The pager and the chapter progress indicator for one node.

    `href(node_id)` is the URL of a node on this surface. `sections(node_id)`
    is that node's `section_headings`; it is only asked about the chapter.
    `solved` is what the reader has solved, when the surface knows it at
    render time (the preview does, from `progress.json`). A surface that
    learns it later marks `[data-progress-items]` itself, and the indicator
    follows.
    """
    ids = [n["id"] for n in order]
    index = ids.index(node_id)
    node = order[index]
    previous = order[index - 1] if index > 0 else None
    following = order[index + 1] if index + 1 < len(order) else None

    pager = '<nav class="book-pager" aria-label="Reading order">'
    pager += _nav_link("prev", previous, href(previous["id"])) if previous else "<span></span>"
    pager += _nav_link("next", following, href(following["id"])) if following else "<span></span>"
    pager += "</nav>"

    def step(rel: str, target: dict | None) -> str:
        if target is None:
            return '<span class="cp-step" aria-hidden="true"></span>'
        label = ("Previous: " if rel == "prev" else "Next: ") + target["title"]
        key = "[" if rel == "prev" else "]"
        glyph = "‹" if rel == "prev" else "›"
        return (
            f'<a class="cp-step" rel="{rel}" href="{html.escape(href(target["id"]))}" '
            f'aria-label="{html.escape(label)}" title="{html.escape(label)} ({key})" '
            f'aria-keyshortcuts="{key}">{glyph}</a>'
        )

    keys = (
        '<button type="button" class="cp-keys" data-book-keys-toggle '
        'aria-keyshortcuts="?" aria-label="Keyboard shortcuts" '
        'title="Keyboard shortcuts (?)">?</button>'
    )
    chapter = chapter_of(order, node_id)
    if chapter is None:
        return {
            "pager": pager,
            "progress": (
                '<nav class="chapter-progress" data-chapter-progress data-kind="none" '
                'aria-label="Where you are">'
                f'{step("prev", previous)}<div class="cp-body"><div class="cp-head">'
                f'<span class="cp-chapter">{html.escape(node["title"])}</span></div></div>'
                f'{step("next", following)}{keys}</nav>'
            ),
        }

    kind = "challenge" if node.get("chapter_number") is not None else "concept"
    on_chapter = node["id"] == chapter["id"]
    heads = sections(chapter["id"])
    practice_ids = [p for p in chapter.get("practice", []) if p in ids]
    done = [p for p in practice_ids if p in solved]
    practice_at = practice_ids.index(node_id) + 1 if node_id in practice_ids else 0

    segments: list[str] = []
    for position, (anchor, text) in enumerate(heads, start=1):
        url = f"#{anchor}" if on_chapter else f"{href(chapter['id'])}#{anchor}"
        current = ' aria-current="location"' if on_chapter and position == 1 else ""
        segments.append(
            f'<li><a class="cp-seg" data-cp-section="{html.escape(anchor)}" '
            f'href="{html.escape(url)}" title="{html.escape(text)}"{current}>'
            f'<span class="cp-sr">Section {position} of {len(heads)}: {html.escape(text)}</span>'
            '</a></li>'
        )
    by_id = {n["id"]: n for n in order}
    for position, practice_id in enumerate(practice_ids, start=1):
        title = by_id[practice_id]["title"]
        state = " data-progress-done" if practice_id in solved else ""
        current = ' aria-current="page"' if practice_id == node_id else ""
        note = " (solved)" if practice_id in solved else ""
        segments.append(
            f'<li><a class="cp-seg cp-practice" data-cp-practice="{html.escape(practice_id)}" '
            f'data-progress-items="{html.escape(practice_id)}"{state} '
            f'href="{html.escape(href(practice_id))}" '
            f'title="Practice {position}: {html.escape(title)}"{current}>'
            f'<span class="cp-sr">Practice {position} of {len(practice_ids)}: '
            f'{html.escape(title)}<span data-cp-solved-note>{note}</span></span></a></li>'
        )

    label = f"Ch {chapter['number']} · {chapter['title']}"
    status = nav_status(kind, 1, len(heads), practice_at, len(practice_ids), len(done))
    progress = (
        f'<nav class="chapter-progress" data-chapter-progress data-kind="{kind}" '
        f'data-chapter="{html.escape(chapter["id"])}" aria-label="Chapter progress">'
        f'{step("prev", previous)}'
        '<div class="cp-body"><div class="cp-head">'
        f'<a class="cp-chapter" href="{html.escape(href(chapter["id"]))}">{html.escape(label)}</a>'
        f'<span class="cp-status" data-cp-status>{status}</span></div>'
        f'<ol class="cp-track" aria-label="{html.escape(label)}: sections and practice">'
        f'{"".join(segments)}</ol></div>'
        f'{step("next", following)}{keys}</nav>'
    )
    return {"pager": pager, "progress": progress}


# The indicator, the pager and the shortcut sheet, for every surface. Colours
# come from `--nav-*` when a surface sets them and otherwise from the book's
# own variables, so the preview needs nothing and the site maps its themes.
NAV_CSS = """
.chapter-progress { --cp-ink: var(--nav-ink, var(--ink, currentColor));
  --cp-dim: var(--nav-dim, var(--dim, #666)); --cp-line: var(--nav-line, var(--line, #e2e2e2));
  --cp-accent: var(--nav-accent, var(--accent, #0369a1)); --cp-done: var(--nav-done, #16a34a);
  display:flex; align-items:center; gap:.4rem; min-width:0; flex:1 1 auto;
  font:.75rem/1.2 ui-sans-serif,system-ui,sans-serif; color:var(--cp-ink); }
.cp-body { display:flex; flex-direction:column; gap:4px; min-width:0; flex:1 1 auto; }
.cp-head { display:flex; align-items:baseline; gap:.5rem; min-width:0; white-space:nowrap; }
.cp-chapter { flex:0 3 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; font-weight:600;
  color:var(--cp-ink); text-decoration:none; }
a.cp-chapter:hover { text-decoration:underline; }
.cp-status { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; color:var(--cp-dim); }
.cp-track { display:flex; gap:3px; margin:0; padding:0; list-style:none; }
.cp-track li { flex:1 1 0; min-width:6px; max-width:44px; margin:0; padding:0; }
.cp-track li:has(.cp-practice) { flex:0 0 14px; }
.cp-seg { position:relative; display:block; height:8px; border-radius:2px; background:var(--cp-line); }
.cp-seg[data-cp-read] { background:color-mix(in srgb, var(--cp-accent) 40%, var(--cp-line)); }
.cp-seg[aria-current] { background:var(--cp-accent); }
.cp-seg.cp-practice { box-sizing:border-box; height:12px; margin-top:-2px;
  border:1.5px solid var(--cp-dim); background:transparent; }
.cp-seg.cp-practice[aria-current] { border-color:var(--cp-accent); box-shadow:0 0 0 1.5px var(--cp-accent); }
.cp-seg.cp-practice[data-progress-done] { border-color:var(--cp-done); background:var(--cp-done); }
.cp-seg.cp-practice[data-progress-done]::after { content:'\\2713'; position:absolute; inset:0;
  color:#fff; font:700 8px/9px ui-sans-serif,system-ui,sans-serif; text-align:center; }
.cp-seg:not(.cp-practice):hover { background:color-mix(in srgb, var(--cp-accent) 60%, var(--cp-line)); }
.cp-seg:focus-visible, .cp-step:focus-visible, .cp-keys:focus-visible, .cp-chapter:focus-visible,
.book-pager a:focus-visible { outline:2px solid var(--nav-accent, var(--accent, currentColor)); outline-offset:2px; }
.cp-step { flex:none; display:inline-flex; align-items:center; justify-content:center; width:1.6rem;
  height:1.6rem; border-radius:6px; color:var(--cp-accent); font-size:1.15rem; line-height:1;
  text-decoration:none; }
a.cp-step:hover { background:color-mix(in srgb, var(--cp-accent) 12%, transparent); }
.cp-keys { flex:none; width:1.5rem; height:1.5rem; padding:0; border:1px solid var(--cp-line);
  border-radius:50%; background:transparent; color:var(--cp-dim);
  font:600 .72rem/1 ui-sans-serif,system-ui,sans-serif; cursor:pointer; }
.cp-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.book-pager { --pg-ink: var(--nav-ink, var(--ink, currentColor)); --pg-dim: var(--nav-dim, var(--dim, #666));
  --pg-line: var(--nav-line, var(--line, #e2e2e2)); --pg-accent: var(--nav-accent, var(--accent, #0369a1));
  display:flex; justify-content:space-between; gap:1rem; margin:3rem 0 1rem; padding-top:1.25rem;
  border-top:1px solid var(--pg-line); font:.9rem/1.35 ui-sans-serif,system-ui,sans-serif; }
.book-pager a { display:flex; flex-direction:column; gap:.2rem; max-width:48%; color:var(--pg-ink);
  text-decoration:none; }
.book-pager a:hover .pager-title { text-decoration:underline; }
.book-pager .pager-next { margin-left:auto; text-align:right; }
.pager-dir { color:var(--pg-dim); font-size:.72rem; letter-spacing:.06em; text-transform:uppercase; }
.pager-title { color:var(--pg-accent); font-weight:600; }
.book-keys { position:fixed; inset:0; z-index:60; display:flex; align-items:center; justify-content:center;
  background:rgb(0 0 0 / .35); }
.book-keys[hidden] { display:none; }
.book-keys-panel { min-width:17rem; max-width:calc(100vw - 2rem); padding:1rem 1.25rem; border-radius:10px;
  background:var(--nav-panel, #fff); color:var(--nav-ink, #1a1a1a);
  box-shadow:0 10px 30px rgb(0 0 0 / .25); font:.85rem/1.5 ui-sans-serif,system-ui,sans-serif; }
.book-keys-panel h2 { margin:0 0 .6rem; font-size:.95rem; }
.book-keys-panel dl { display:grid; grid-template-columns:auto 1fr; gap:.35rem .9rem; margin:0; }
.book-keys-panel dt { text-align:right; }
.book-keys-panel dd { margin:0; }
.book-keys-panel kbd { display:inline-block; min-width:1.4em; padding:.05rem .35rem; border:1px solid currentColor;
  border-radius:4px; font:600 .78rem/1.3 ui-monospace,monospace; text-align:center; }
.book-keys-panel button { margin-top:.9rem; padding:.3rem .7rem; border:1px solid currentColor; border-radius:6px;
  background:transparent; color:inherit; font:inherit; cursor:pointer; }
@media print { .chapter-progress, .book-pager, .book-keys { display:none !important; } }
"""
