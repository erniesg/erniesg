"""The plain reader's chrome: the chapter rail, the front page's bar, print.

`preview.py` and the published site (through `manifest.py`) draw these from
here, so the plain look is the same wherever the book is opened. Every link
goes through `href(node_id)`, the URL of a node on that surface. The topic map
is `render.py`'s.
"""

from __future__ import annotations

import html
import re

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
                f'<p class="rail-more"><a href="{html.escape(map_href)}">Open the map →</a></p>'
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


def print_markup(order: list[dict], render) -> str:
    """The whole book in reading order, as the print edition lays it out.

    `render(node)` is the node rendered for the print target; the ids match the
    preview's `/print#print-<id>` anchors.
    """
    return "".join(
        f"<article class='print-page' id='print-{html.escape(node['id'])}'>{render(node)}</article>"
        for node in order
    )


# The rail's styles. Colours come from the book's variables (`--ink`, `--dim`,
# `--line`, `--accent`), which each surface sets.
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

# The print edition's page breaks between nodes, as the preview's /print draws them.
PRINT_CSS = """
.lede { font-size:1.1rem; }
.print-page { border-bottom:1px solid var(--line); padding-bottom:2rem; margin-bottom:2rem; }
"""
