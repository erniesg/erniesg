#!/usr/bin/env python3
"""Check every node before it reaches the compiler.

  python3 challenges/tools/validate.py

Fails loudly on: missing front matter keys, missing required blocks, a figure
that is not declared or does not exist, missing tier tests, an edge pointing at
a node that does not exist, or a cycle in `requires`.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

if sys.version_info < (3, 11):
    sys.exit(f"This needs Python 3.11+; this is Python {sys.version.split()[0]}.")

import tomllib

CHALLENGES_DIR = Path(__file__).resolve().parent.parent
FIGURES_DIR = CHALLENGES_DIR / "figures"
TIERS = ["public", "edge", "stress", "perf"]
FIGURE_TYPES = {"cells", "walk", "links", "table", "cost"}

BLOCKS = re.compile(r"^:::(\w+)", re.MULTILINE)
REQUIRED_BLOCKS = {
    "challenge": {"statement", "io", "constraints", "sample", "figure", "run", "hint", "solution"},
    "concept": set(),
}
EDGE_KEYS = ["requires", "assessed-by", "harder-variant-of", "motivates"]

problems: list[str] = []


def fail(where: Path, message: str) -> None:
    problems.append(f"{where.relative_to(CHALLENGES_DIR.parent)}: {message}")


def read_front_matter(path: Path) -> tuple[dict, str]:
    text = path.read_text()
    if not text.startswith("+++"):
        fail(path, "does not start with a +++ front matter block")
        return {}, text
    _, raw, body = text.split("+++", 2)
    try:
        return tomllib.loads(raw), body
    except tomllib.TOMLDecodeError as error:
        fail(path, f"front matter is not valid TOML: {error}")
        return {}, body


def front_matter_ids() -> set[str]:
    ids = set()
    for path_file in (CHALLENGES_DIR / "paths").glob("*.toml"):
        data = tomllib.loads(path_file.read_text())
        if data.get("front_matter"):
            ids.add(data["front_matter"])
    return ids


def check_node(path: Path, meta: dict, body: str) -> None:
    for key in ("id", "kind", "title"):
        if key not in meta:
            fail(path, f"front matter is missing `{key}`")
    kind = meta.get("kind", "")
    if kind not in REQUIRED_BLOCKS:
        fail(path, f"unknown kind `{kind}`")
        return

    present = set(BLOCKS.findall(body))
    required = set(REQUIRED_BLOCKS[kind])
    if kind == "concept" and meta.get("figure"):
        required.add("figure")
    for block in sorted(required - present):
        fail(path, f"missing required block :::{block}")

    figure = meta.get("figure")
    if not figure:
        # The book's own front matter introduces, it does not teach, so it is
        # the one node that may stand without a diagram.
        if meta.get("id") not in front_matter_ids():
            fail(path, "every concept and challenge needs a figure")
    elif not (FIGURES_DIR / f"{figure}.json").is_file():
        fail(path, f"figure `{figure}` has no file in challenges/figures/")

    if kind != "challenge":
        return

    node_dir = path.parent
    if "module" not in meta:
        fail(path, "a challenge needs `module` in its front matter")
    for name in ("starter.py", "solution.py"):
        if not (node_dir / name).is_file():
            fail(path, f"missing {name}")
    for tier in TIERS:
        if not (node_dir / "tests" / f"{tier}.py").is_file():
            fail(path, f"missing tests/{tier}.py")
        if tier not in meta.get("tiers", {}):
            fail(path, f"front matter has no [tiers.{tier}]")


def check_figures() -> None:
    for figure in sorted(FIGURES_DIR.glob("*.json")):
        import json

        try:
            data = json.loads(figure.read_text())
        except json.JSONDecodeError as error:
            fail(figure, f"is not valid JSON: {error}")
            continue
        if data.get("type") not in FIGURE_TYPES:
            fail(figure, f"type must be one of {sorted(FIGURE_TYPES)}")
        for key in ("id", "title", "caption"):
            if not data.get(key):
                fail(figure, f"missing `{key}`")
        if data.get("id") != figure.stem:
            fail(figure, f"id `{data.get('id')}` does not match the filename")


def check_graph(nodes: dict[str, dict]) -> None:
    for node_id, meta in nodes.items():
        for key in EDGE_KEYS:
            for target in meta.get(key, []):
                if target not in nodes:
                    problems.append(f"{node_id}: {key} points at unknown node `{target}`")

    # requires must be acyclic: peel nodes whose prerequisites are all settled.
    pending = {n: set(m.get("requires", [])) & set(nodes) for n, m in nodes.items()}
    settled: set[str] = set()
    while True:
        ready = {n for n, deps in pending.items() if deps <= settled and n not in settled}
        if not ready:
            break
        settled |= ready
    if len(settled) != len(pending):
        stuck = ", ".join(sorted(set(pending) - settled))
        problems.append(f"`requires` has a cycle among: {stuck}")


def check_paths(nodes: dict[str, dict]) -> None:
    for path_file in sorted((CHALLENGES_DIR / "paths").glob("*.toml")):
        data = tomllib.loads(path_file.read_text())
        for part in data.get("parts", []):
            for node_id in part.get("nodes", []):
                if node_id not in nodes:
                    fail(path_file, f"part `{part.get('id')}` lists unknown node `{node_id}`")


def main() -> int:
    nodes: dict[str, dict] = {}
    files = sorted(CHALLENGES_DIR.glob("*.md")) + sorted(CHALLENGES_DIR.glob("*/challenge.md"))
    for path in files:
        meta, body = read_front_matter(path)
        if not meta:
            continue
        check_node(path, meta, body)
        node_id = meta.get("id")
        if node_id in nodes:
            fail(path, f"duplicate node id `{node_id}`")
        elif node_id:
            nodes[node_id] = meta

    check_figures()
    check_graph(nodes)
    check_paths(nodes)

    if problems:
        print(f"\n{len(problems)} problem(s):\n")
        for problem in problems:
            print(f"  ✘ {problem}")
        return 1
    print(f"✔ {len(nodes)} node(s) valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
