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
# The page shows the hints and the solution itself, so a note only says what
# the page cannot: `unaided` is the check on whether the chapter stuck.
SUPPORT_NOTES = {
    "worked": "",
    "guided": "",
    "contract": "",
    "unaided": "This one tells you whether it stuck.",
}
RUNG_LABELS = ("a nudge", "a direction", "the shape of it", "most of the way")
FIGURE_TYPES = ("cells", "walk", "links", "table", "cost")


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
        f'<p class="labelled"><b>Limits.</b> {limits.get("time_seconds", "?")} seconds, '
        f'{limits.get("memory_mb", "?")} MB.</p>'
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


def figure(figure_id: str, caption_override: str = "", target: str = "web", number: int | None = None) -> str:
    """A figure, numbered so the prose can refer to it by name.

    A reader meeting a chart needs to know which figure it is and what it
    shows, in that order, without hunting for the sentence that introduced it.
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
    body = _figure_body(data, kind, target)
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


def render_node(node: dict, target: str = "web", solved: bool = False) -> str:
    """One node, one markup, differing only where a target cannot follow.

    `solved` gates what a challenge is willing to show: an unaided problem
    keeps its solution until the tiers are green. Print shows everything,
    because a book cannot know who is reading it.
    """
    support = node.get("support", "guided")
    pieces = split_blocks(node["body"])
    card_parts = {name: inner for name, _, inner in pieces if name in CARD_BLOCKS}
    out: list[str] = []
    if node.get("part"):
        out.append(f'<p class="eyebrow">{html.escape(node["part"])}</p>')
    out.append(f'<h1>{html.escape(node["title"])}</h1>')
    if node.get("kind") == "challenge" and SUPPORT_NOTES.get(support):
        out.append(
            f'<p class="support support-{support}">'
            f'{html.escape(SUPPORT_NOTES[support])}</p>'
        )
    hints: list[str] = []
    card_done = False

    def flush_hints() -> None:
        if not hints:
            return
        if target == "print":
            out.append('<div class="hints">' + "".join(hints) + "</div>")
        else:
            total = len(hints)
            rungs = "".join(
                rung.replace("{label}", html.escape(_rung_label(i, total)))
                for i, rung in enumerate(hints)
            )
            pips = '<span class="pip"></span>' * total
            out.append(
                f'<details class="ladder" data-ladder="{html.escape(node["id"])}" '
                f'data-total="{total}"><summary><span class="ladder-count">0 of {total} '
                f'hints</span><span class="pips" aria-hidden="true">{pips}</span>'
                '<span class="ladder-note">each one gives away more</span></summary>'
                f'<ol class="rungs">{rungs}</ol></details>'
            )
        hints.clear()

    figure_number = 0
    for name, attrs, inner in pieces:
        if name in CARD_BLOCKS:
            if not card_done:
                out.append(problem_card(node, card_parts))
                card_done = True
            continue
        if name == "prose":
            rendered = render_markdown(inner)
            out.append(rendered if target == "print" else _runnable(rendered))
        elif name == "problem":
            referenced = load_node(attrs.get("id", ""))
            parts = {n: i for n, _, i in split_blocks(referenced["body"]) if n in CARD_BLOCKS}
            out.append(problem_card(referenced, parts))
        elif name == "figure":
            figure_number += 1
            out.append(figure(attrs.get("id", ""), inner, target, figure_number))
        elif name == "hint":
            if support == "unaided" and target != "print":
                continue
            level = html.escape(attrs.get("level", str(len(hints) + 1)))
            if target == "print":
                hints.append(
                    f'<div class="hint"><p class="hint-title">Hint {level}</p>'
                    f"{render_markdown(inner)}</div>"
                )
            else:
                hints.append(
                    f"<li><details class='hint rung' data-rung='{len(hints) + 1}'>"
                    f"<summary>Hint {level} <span class='rung-label'>{{label}}</span></summary>"
                    f"{render_markdown(inner)}</details></li>"
                )
        elif name == "solution":
            flush_hints()
            locked = support in ("contract", "unaided") and not solved
            if locked and target != "print":
                out.append(
                    '<p class="locked-solution">The worked solution unlocks when all '
                    "four tiers are green.</p>"
                )
                continue
            if target == "print":
                out.append(
                    '<div class="solution"><p class="solution-title">Worked solution</p>'
                    f"{render_markdown(inner)}</div>"
                )
            else:
                out.append(
                    "<details class='solution'><summary>Worked solution "
                    "<span class='rung-label'>the whole answer</span></summary>"
                    f"{render_markdown(inner)}</details>"
                )
        elif name == "run":
            out.append(_desk(node, attrs, target))
        elif name == "exercise":
            out.append(exercise(attrs.get("id", ""), inner, target))
    flush_hints()
    return "".join(out)


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
        '<div class="verdict" hidden></div></div>'
        "<details class='answer'><summary>Show the answer</summary>"
        f'<pre><code>{html.escape(parts["answer"])}</code></pre></details></section>'
    )


RUNNABLE = re.compile(r'<pre><code class="language-python run">(.*?)</code></pre>', re.DOTALL)
GRADE_LINE = re.compile(r"^ *python3 challenges/tools/grade\.py \S+\n", re.MULTILINE)

KEYS_HINT = (
    '<span class="keys-hint" role="note">Tab indents \u00b7 '
    '<kbd>Esc</kbd> then <kbd>Tab</kbd> leaves the editor \u00b7 '
    '<kbd>\u2318\u21e7\u21b5</kbd> runs and moves on</span>'
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


def _desk(node: dict, attrs: dict, target: str) -> str:
    starter = ""
    if node.get("dir"):
        path = node["dir"] / attrs.get("starter", "starter.py")
        if path.is_file():
            starter = path.read_text()
    if target == "print":
        return (
            '<h2>Your turn</h2><pre><code>' + html.escape(starter) + "</code></pre>"
            '<p class="figure-note">Run and grade this in the web edition, or from a '
            "terminal with the book's grader.</p>"
        )
    starter = GRADE_LINE.sub("    Press Run (\u2318\u21b5) to grade it.\n", starter)
    return (
        f'<section class="desk" data-node="{html.escape(node["id"])}">'
        f'<textarea class="editor" spellcheck="false">{html.escape(starter)}</textarea>'
        '<div class="desk-actions"><button class="run">Run all tiers <kbd>\u2318\u21b5</kbd></button>'
        f'<span class="status">The first run is supposed to be red.</span>{KEYS_HINT}</div>'
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
.ladder { border:1px solid var(--line); border-radius:8px; background:#fff; margin:1.2rem 0 .6rem;
  padding:8px 12px; }
.ladder > summary { display:flex; align-items:center; gap:10px; list-style:none; }
.ladder > summary::-webkit-details-marker { display:none; }
.ladder > summary::before { content:"▸"; color:var(--dim); }
.ladder[open] > summary::before { content:"▾"; }
.ladder-note { font-weight:400; color:var(--dim); font-size:.78rem; margin-left:auto; }
.pips { display:inline-flex; gap:4px; }
.pip { width:9px; height:9px; border-radius:50%; border:1.5px solid #b45309; }
.pip.spent { background:#b45309; }
.rungs { list-style:none; padding:0; margin:.6rem 0 0; }
.rung { margin:6px 0; border-style:dashed; }
.rung.spent { border-style:solid; border-color:#e7c9a4; background:#fffaf2; }
.rung.spent > summary::after { content:" · read"; font-weight:400; color:#b45309; }
.rung-label { font-weight:400; color:var(--dim); }
details.solution { border:0; border-top:2px solid var(--ink); border-radius:0; background:none;
  padding:10px 0 0; margin-top:1.4rem; }
.exercise { margin:1.8rem 0; padding:12px 16px 14px; border-left:4px solid #15803d;
  background:#f3faf5; border-radius:0 8px 8px 0; }
.exercise-title { font:700 .72rem/1 ui-sans-serif,system-ui; letter-spacing:.09em;
  text-transform:uppercase; color:#15803d; margin:0 0 .5rem; }
.exercise .answer { margin-top:.6rem; }
.verdict { font:.85rem ui-sans-serif,system-ui; margin-top:8px; }
.verdict.pass { color:#15803d; font-weight:600; }
.verdict.fail .columns { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.verdict.fail pre { margin:4px 0 0; font-size:.8rem; }
.verdict .col-label { font-weight:600; color:var(--dim); }
.hint-title, .solution-title { font:600 .85rem ui-sans-serif,system-ui; margin:.2rem 0; }
details summary { cursor:pointer; font:600 .85rem ui-sans-serif,system-ui; }
.missing { color:#b91c1c; font:.85rem ui-sans-serif,system-ui; }
.support { font:.82rem/1.5 ui-sans-serif,system-ui; color:var(--dim); margin:-.4rem 0 1.2rem;
  padding-left:.7rem; border-left:3px solid var(--line); }
.support-worked { border-left-color:#15803d; }
.support-guided { border-left-color:#0369a1; }
.support-contract { border-left-color:#b45309; }
.support-unaided { border-left-color:#be185d; }
.keys-hint { font:.72rem ui-sans-serif,system-ui; color:var(--dim); margin-left:auto; }
.keys-hint kbd { font:inherit; border:1px solid var(--line); border-radius:3px; padding:0 .25em; }
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
