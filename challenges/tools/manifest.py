#!/usr/bin/env python3
"""Every book path, rendered once, as JSON the site reads at build time.

    python3 challenges/tools/manifest.py [--out FILE]

`render.py` stays the only thing that emits block markup. This walks the paths
in `challenges/paths/`, calls `render_node` for the web target, and hands the
result over verbatim; the Astro build embeds it and re-renders nothing. A
second renderer in TypeScript would mean the web and the EPUB drift, and the
reader would see two different books.

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
    BLOCK_TAG,
    CHALLENGES,
    CONTENT_CSS,
    PART_NAMES,
    all_nodes,
    load_book,
    load_topics,
    render_node,
)

PATHS = CHALLENGES / "paths"
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
HEADING = re.compile(r'<h([23]) id="([^"]+)">(.*?)</h\1>', re.DOTALL)
TAGS = re.compile(r"<[^>]+>")


def path_ids() -> list[str]:
    return sorted(path.stem for path in PATHS.glob("*.toml"))


def read_path(path_id: str) -> dict:
    return tomllib.loads((PATHS / f"{path_id}.toml").read_text())


def book_slug(path_id: str, data: dict) -> str:
    """The URL segment, taken from `slug` and from nothing else.

    `id` would mean a hand-kept mapping in route code, and a slugified `title`
    would move the URL the day the title is edited. Annotations anchor to the
    document URI, so a moved URL silently orphans every note on the book.
    """
    slug = str(data.get("slug", "")).strip()
    if not SLUG.fullmatch(slug):
        raise SystemExit(
            f"challenges/paths/{path_id}.toml needs a url-safe `slug`: the "
            f"published route is derived from that field alone"
        )
    return slug


def node_entry(node: dict, slug: str) -> dict:
    # The published site is a static host: it cannot run the reader's code, so
    # it asks for the listings the print edition gets rather than dead buttons.
    # It has no grader either, so the reader opens hints and solutions rather
    # than waiting on tiers that will never turn green here.
    markup = render_node(node, "web", runnable=False, reveal="reader")
    return {
        "id": node["id"],
        "title": node["title"],
        "kind": node.get("kind", ""),
        "support": node.get("support", ""),
        "part": node.get("part", ""),
        "partNumber": node.get("part_number", ""),
        "number": node.get("number", ""),
        "path": f"/books/{slug}/{node['id']}/",
        "html": markup,
        "blocks": [
            {"kind": kind, "id": identifier, "digest": digest}
            for kind, digest, identifier in BLOCK_TAG.findall(markup)
        ],
        "outline": [
            {"level": int(level), "id": anchor, "text": TAGS.sub("", text).strip()}
            for level, anchor, text in HEADING.findall(markup)
        ],
    }


def topic_entries(order: list[dict]) -> list[dict]:
    """The map: every topic the book covers, and what stands where.

    `order` is this book's nodes in reading order, and it is the only pool the
    map may draw on. The node pool is shared, so scanning all of it would give
    every path the same attachments — a second path that selects a subset would
    count topics it never teaches and link to chapters it does not contain.
    Reading order also beats filesystem order: "what stands here" means the
    chapter the reader reaches, so the links follow the book.

    Topics with nothing written yet are part of the shape of the book, so they
    are listed rather than hidden.
    """
    topics = load_topics()
    attached: dict[str, list[dict]] = {topic_id: [] for topic_id in topics}
    for node in order:
        for topic_id in node.get("teaches", []):
            if topic_id in attached:
                attached[topic_id].append(node)
    return [
        {
            "id": topic_id,
            "title": topic["title"],
            "part": int(topic.get("part", 0)),
            "partName": PART_NAMES.get(int(topic.get("part", 0)), ""),
            "agent": topic.get("agent", ""),
            "requires": [
                topics[other]["title"] for other in topic.get("requires", []) if other in topics
            ],
            "unlocks": [
                other["title"]
                for other in topics.values()
                if topic_id in other.get("requires", [])
            ],
            "nodes": [
                {"id": node["id"], "title": node["title"], "kind": node.get("kind", "")}
                for node in attached[topic_id]
            ],
        }
        for topic_id, topic in topics.items()
    ]


def book_entry(path_id: str) -> dict:
    data = read_path(path_id)
    slug = book_slug(path_id, data)
    book, order = load_book(path_id)
    return {
        "pathId": path_id,
        "slug": slug,
        "id": str(data.get("id", path_id)),
        "title": book.get("title", ""),
        "subtitle": book.get("subtitle", ""),
        "edition": book.get("edition", ""),
        "author": book.get("author", ""),
        "collection": book.get("collection", ""),
        "path": f"/books/{slug}/",
        "frontMatter": str(data.get("front_matter", "")),
        "parts": [
            {
                "id": str(part.get("id", "")),
                "title": str(part.get("title", "")),
                "nodes": list(part.get("nodes", [])),
            }
            for part in data.get("parts", [])
        ],
        "nodes": [node_entry(node, slug) for node in order],
        "topics": topic_entries(order),
    }


def build_manifest() -> dict:
    collection = tomllib.loads((CHALLENGES / "book.toml").read_text())
    books = [book_entry(path_id) for path_id in path_ids()]
    slugs = [book["slug"] for book in books]
    if len(set(slugs)) != len(slugs):
        raise SystemExit("two book paths claim the same `slug`; a URL has one book")
    return {
        "schemaVersion": 1,
        "generator": "challenges/tools/render.py",
        "collection": collection.get("collection", ""),
        "poolNodeCount": len(all_nodes()),
        "contentCss": CONTENT_CSS,
        "books": books,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Render every book path to JSON.")
    parser.add_argument("--out", type=Path, help="write here instead of stdout")
    args = parser.parse_args()
    payload = json.dumps(build_manifest(), ensure_ascii=False, separators=(",", ":"))
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(payload)
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
