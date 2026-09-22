#!/usr/bin/env python3
"""The book, rendered once, as JSON the published site reads.

    python3 challenges/tools/web_book.py             -> JSON on stdout
    python3 challenges/tools/web_book.py --out FILE  -> JSON in a file

`render.py` is the only thing that emits block markup, and a static host cannot
call Python when a reader arrives. So the site's build calls this once, and the
Astro routes embed what comes back verbatim. Nothing here is hand-listed: the
route set, the contents and the topic map all come from `load_book()`,
`all_nodes()` and `load_topics()`, which is what makes the twenty-two topics
still to come free to add.

The site is static, so nodes are rendered with `interactive=False`: where the
EPUB shows a listing, the web shows a listing. Running the tiers in the browser
is a later issue.

Stdlib only; needs Python 3.11+ for tomllib.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

if sys.version_info < (3, 11):
    sys.exit(f"This needs Python 3.11+; this is Python {sys.version.split()[0]}.")

import tomllib

from render import (
    CHALLENGES,
    CONTENT_CSS,
    EDGE_KINDS,
    FIGURE_SCRIPT,
    PART_NAMES,
    WEB_FIGURE_CSS,
    all_nodes,
    load_book,
    load_node,
    load_topics,
    render_node,
    scoped_css,
)

BASE = "/challenges"
SCOPE = ".book-text"

BLOCK_ID = re.compile(r'data-block-id="([^"]+)"')
HEADING = re.compile(r'<h([23]) id="([^"]+)">(.*?)</h\1>', re.DOTALL)
TAG = re.compile(r"<[^>]+>")


def node_path(node_id: str) -> str:
    return f"{BASE}/{node_id}/"


def outline(rendered: str) -> list[dict]:
    """The headings a reader can jump to, in the order they appear."""
    return [
        {"id": anchor, "level": int(level), "text": TAG.sub("", text).strip()}
        for level, anchor, text in HEADING.findall(rendered)
    ]


def connections(node: dict, nodes: dict[str, dict]) -> list[dict]:
    """This node's edges, named so a reader knows why the link is there."""
    found = []
    for kind, (colour, label) in EDGE_KINDS.items():
        for target in node.get(kind, []):
            known = target in nodes
            found.append({
                "kind": kind,
                "label": label,
                "colour": colour,
                "id": target,
                "title": nodes[target]["title"] if known else target.replace("-", " "),
                "path": node_path(target) if known else "",
            })
    return found


def contents(order: list[dict], topics: dict[str, dict], nodes: dict[str, dict]) -> list[dict]:
    """The whole book, not just the pages that exist yet.

    Written nodes sit where they belong; a topic with nothing written yet is
    listed as still to come. A reader can see the shape of the book and how
    much of it is standing, which is the same promise the local reader makes.
    """
    written_topics = {
        topic_id for node in nodes.values() for topic_id in node.get("teaches", [])
    }

    intro = [n for n in order if not n.get("part") or n.get("part_number") == ""]
    introduced = {n["id"] for n in intro}
    by_part: dict[str, list[dict]] = {}
    for node in order:
        if node["id"] in introduced:
            continue
        by_part.setdefault(node["part_number"], []).append(node)

    parts: list[dict] = []
    if intro:
        parts.append({
            "number": "",
            "title": "Introduction",
            "nodes": [row(node) for node in intro],
            "planned": [],
        })
    numbers = sorted(
        {str(topic.get("part", 0)) for topic in topics.values()} | set(by_part),
        key=int,
    )
    for number in numbers:
        parts.append({
            "number": number,
            "title": f"Part {number} · {PART_NAMES.get(int(number), '')}",
            "nodes": [row(node) for node in by_part.get(number, [])],
            "planned": [
                {"id": topic["id"], "title": topic["title"]}
                for topic in topics.values()
                if str(topic.get("part", 0)) == number and topic["id"] not in written_topics
            ],
        })
    return parts


def row(node: dict) -> dict:
    return {
        "id": node["id"],
        "title": node["title"],
        "number": node.get("number", ""),
        "kind": node.get("kind", ""),
        "path": node_path(node["id"]),
    }


def topic_map(topics: dict[str, dict], nodes: dict[str, dict]) -> list[dict]:
    """Every topic the book covers, what it needs first, and what it unlocks."""
    attached: dict[str, list[dict]] = {topic_id: [] for topic_id in topics}
    for node in nodes.values():
        for topic_id in node.get("teaches", []):
            if topic_id in attached:
                attached[topic_id].append(node)
    return [
        {
            "id": topic_id,
            "title": topic["title"],
            "part": topic.get("part", 0),
            "partName": PART_NAMES.get(topic.get("part", 0), ""),
            "agent": topic.get("agent", ""),
            "requires": [
                topics[parent]["title"] for parent in topic.get("requires", [])
                if parent in topics
            ],
            "unlocks": [
                other["title"] for other in topics.values()
                if topic_id in other.get("requires", [])
            ],
            "nodes": [row(node) for node in attached[topic_id]],
        }
        for topic_id, topic in topics.items()
    ]


def build(path_id: str = "agent") -> dict:
    book, order = load_book(path_id)
    nodes = all_nodes()
    topics = load_topics()
    collection = tomllib.loads((CHALLENGES / "book.toml").read_text())

    # Routes come from the path first, then from any node in the pool the path
    # has not picked up yet. A node that exists has a URL; that is what 056-060
    # need to anchor to, and no list here has to be kept in step by hand.
    on_the_path = {n["id"] for n in order}
    ordered = list(order) + [
        {**load_node(node_id), "part": "", "part_number": "", "number": ""}
        for node_id in nodes
        if node_id not in on_the_path
    ]

    rendered_nodes = []
    for position, node in enumerate(ordered):
        on_path = position < len(order)
        markup = render_node(node, "web", interactive=False)
        rendered_nodes.append({
            "id": node["id"],
            "title": node["title"],
            "kind": node.get("kind", ""),
            "support": node.get("support", ""),
            "number": node.get("number", ""),
            "part": node.get("part", ""),
            "partNumber": node.get("part_number", ""),
            "path": node_path(node["id"]),
            "onPath": on_path,
            "previous": row(order[position - 1]) if on_path and position > 0 else None,
            "next": row(order[position + 1]) if on_path and position + 1 < len(order) else None,
            "teaches": list(node.get("teaches", [])),
            "edges": connections(node, nodes),
            "outline": outline(markup),
            "blockIds": BLOCK_ID.findall(markup),
            "html": markup,
        })

    return {
        "generator": "challenges/tools/web_book.py",
        "renderer": "challenges/tools/render.py",
        "base": BASE,
        "scope": SCOPE,
        "path": path_id,
        "book": {
            "title": book.get("title", "Challenges"),
            "subtitle": book.get("subtitle", ""),
            "edition": book.get("edition", ""),
            "author": book.get("author", collection.get("author", "")),
            "slug": collection.get("slug", "challenges"),
        },
        "counts": {
            "pathNodes": len(order),
            "allNodes": len(nodes),
            "routes": len(rendered_nodes),
            "topics": len(topics),
        },
        "css": scoped_css(CONTENT_CSS + WEB_FIGURE_CSS, SCOPE),
        "script": FIGURE_SCRIPT,
        "contents": contents(order, topics, nodes),
        "topics": topic_map(topics, nodes),
        "nodes": rendered_nodes,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--path", default="agent", help="which path over the node pool")
    parser.add_argument("--out", type=Path, help="write here instead of stdout")
    args = parser.parse_args()

    # `sort_keys` and no whitespace: two runs over unchanged source produce the
    # same bytes, which is what the build's stability test rests on.
    payload = json.dumps(build(args.path), sort_keys=True, separators=(",", ":"))
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(payload)
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
