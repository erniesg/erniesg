#!/usr/bin/env python3
"""Every book path, rendered once, as JSON the site reads at build time.

    python3 books/tools/manifest.py [--out FILE]

`render.py` stays the only thing that emits block markup. This walks the books
(`books/<id>.toml`), calls `render_node` for the web target, and hands the
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

from chrome import (
    MAP_CSS,
    RAIL_CSS,
    chapter_rail,
    front_navigation,
    map_markup,
    map_payload,
    print_markup,
)
from render import (
    BLOCK_TAG,
    BOOKS,
    COLLECTION_FILE,
    CONTENT_CSS,
    NAV_CSS,
    PART_NAMES,
    SPLIT_CSS,
    SPLIT_SCRIPT,
    all_nodes,
    book_files,
    load_book,
    load_topics,
    node_path,
    reading_navigation,
    render_node,
    section_headings,
)

SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
HEADING = re.compile(r'<h([23]) id="([^"]+)">(.*?)</h\1>', re.DOTALL)
TAGS = re.compile(r"<[^>]+>")
EXERCISE_ID = re.compile(r'<section class="exercise" id="ex-([a-z0-9-]+)"')


def path_ids() -> list[str]:
    return sorted(path.stem for path in book_files())


def read_path(path_id: str) -> dict:
    return tomllib.loads((BOOKS / f"{path_id}.toml").read_text())


def book_slug(path_id: str, data: dict) -> str:
    """The URL segment, taken from `slug` and from nothing else.

    `id` would mean a hand-kept mapping in route code, and a slugified `title`
    would move the URL the day the title is edited. Annotations anchor to the
    document URI, so a moved URL silently orphans every note on the book.
    """
    slug = str(data.get("slug", "")).strip()
    if not SLUG.fullmatch(slug):
        raise SystemExit(
            f"books/{path_id}.toml needs a url-safe `slug`: the "
            f"published route is derived from that field alone"
        )
    return slug


TIER_ORDER = ("public", "edge", "stress", "perf")


def grading_entry(node: dict) -> dict | None:
    """What the browser needs to grade a challenge as `grade.py` does.

    The site has no server to grade on, so the reader's browser runs the
    tiers in Python itself (`runtime/browser-backend.mjs`): each tier's test
    file and time limit, and the module name the tests import the reader's
    code by. The tests are in the public repository already; nothing is
    shipped here that a reader could not read on GitHub.
    """
    folder = node.get("dir")
    if node.get("kind") != "challenge" or not folder or not node.get("module"):
        return None
    tiers = []
    for tier in TIER_ORDER:
        test_file = folder / "tests" / f"{tier}.py"
        if test_file.is_file():
            limit = node.get("tiers", {}).get(tier, {}).get("timeout", 60)
            tiers.append({"tier": tier, "timeout": int(limit), "source": test_file.read_text()})
    return {"module": node["module"], "tiers": tiers} if tiers else None


def node_entry(node: dict, slug: str) -> dict:
    # The published site runs the reader's code in their own browser (Pyodide):
    # exercises, runnable cells, and each challenge's four tiers, so it gets the
    # same runnable page the preview does. It has no one watching the tiers,
    # though, so the reader opens hints and solutions themselves (`reveal`).
    markup = render_node(node, "web", runnable=True, reveal="reader")
    return {
        "id": node["id"],
        "title": node["title"],
        "kind": node.get("kind", ""),
        "support": node.get("support", ""),
        "part": node.get("part", ""),
        "partNumber": node.get("part_number", ""),
        "number": node.get("number", ""),
        "path": f"/books/{slug}/{node['id']}/",
        # The node's Markdown source, repo-relative. The site stamps the commit
        # that last touched it, so an edit proposal names the text it changes.
        "sourcePath": node_path(node["id"]).relative_to(BOOKS.parent).as_posix(),
        "html": markup,
        "blocks": [
            {"kind": kind, "id": identifier, "digest": digest}
            for kind, digest, identifier in BLOCK_TAG.findall(markup)
        ],
        "outline": [
            {"level": int(level), "id": anchor, "text": TAGS.sub("", text).strip()}
            for level, anchor, text in HEADING.findall(markup)
        ],
        # The ids reading progress keys an exercise by, so the site can count
        # them without parsing a node itself.
        "exercises": EXERCISE_ID.findall(markup),
        "grading": grading_entry(node),
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


def with_navigation(order: list[dict], entries: list[dict]) -> list[dict]:
    """Each node's pager and chapter indicator, as `render.py` writes them.

    The site knows the reader's solved challenges only in the browser, so
    nothing is solved here; the progress runtime marks the segments later.
    """
    markup = {entry["id"]: entry["html"] for entry in entries}
    paths = {entry["id"]: entry["path"] for entry in entries}
    for entry in entries:
        nav = reading_navigation(
            order,
            entry["id"],
            paths.__getitem__,
            lambda node_id: section_headings(markup[node_id]),
        )
        entry["pager"] = nav["pager"]
        entry["progress"] = nav["progress"]
    return entries


def book_entry(path_id: str, collection: dict) -> dict:
    data = read_path(path_id)
    slug = book_slug(path_id, data)
    book, order = load_book(path_id)
    entries = with_navigation(order, [node_entry(node, slug) for node in order])
    base = f"/books/{slug}/"

    def href(node_id: str) -> str:
        return f"{base}{node_id}/"

    for node, entry in zip(order, entries):
        # The plain look's right column: what is on this page and what it
        # connects to in this book, as the local preview draws it.
        entry["rail"] = chapter_rail(entry["html"], node, order, href, f"{base}map/")
    return {
        "pathId": path_id,
        "slug": slug,
        "id": str(data.get("id", path_id)),
        "title": book.get("title", ""),
        "subtitle": book.get("subtitle", ""),
        "edition": book.get("edition", ""),
        "author": book.get("author", ""),
        "collection": book.get("collection", collection.get("collection", "")),
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
        "nodes": entries,
        "topics": topic_entries(order),
        # The front page's bar, the map page and the print edition, drawn by
        # the same code as the local preview's.
        "front": front_navigation(order, href),
        "mapHtml": map_markup(map_payload(order), f"{base}{{id}}/"),
        "printHtml": print_markup(order, lambda node: render_node(node, "print")),
    }


def build_manifest() -> dict:
    collection = tomllib.loads(COLLECTION_FILE.read_text())
    books = [book_entry(path_id, collection) for path_id in path_ids()]
    slugs = [book["slug"] for book in books]
    if len(set(slugs)) != len(slugs):
        raise SystemExit("two book paths claim the same `slug`; a URL has one book")
    return {
        "schemaVersion": 1,
        "generator": "books/tools/render.py",
        "collection": collection.get("collection", ""),
        "poolNodeCount": len(all_nodes()),
        "contentCss": CONTENT_CSS,
        # The side-by-side view: rooted on <html>, so the site includes it
        # unscoped, and the same toggle script the local preview runs.
        "splitCss": SPLIT_CSS,
        "splitScript": SPLIT_SCRIPT,
        "navCss": NAV_CSS,
        # The plain look's rail, and the map and print pages.
        "railCss": RAIL_CSS,
        "mapCss": MAP_CSS,
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
