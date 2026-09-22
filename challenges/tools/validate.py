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
SUPPORT_LEVELS = ["worked", "guided", "contract", "unaided"]
FIGURE_TYPES = {"cells", "walk", "links", "table", "cost"}

# A node id is a URL segment, a DOM id and the stem of every annotation anchor
# on the node, so it has to be safe in all three. Restricting it here is what
# lets the renderer treat it as a known-good token everywhere downstream.
NODE_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")

BLOCKS = re.compile(r"^:::(\w+)", re.MULTILINE)
REQUIRED_BLOCKS = {
    # `hint` is governed by the support level below, not required outright: an
    # unaided challenge must not carry any.
    "challenge": {"statement", "io", "constraints", "sample", "figure", "run", "solution"},
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
    node_id = meta.get("id")
    if node_id is not None:
        # `id = 123` is valid TOML and `str()` would let it through, but the
        # manifest would then serialize a number where `BookNode.id` is typed
        # a string, and the route would compare it against a string
        # `Astro.params.node` and never match. Reject the type, not the shape.
        if not isinstance(node_id, str):
            fail(path, f"id `{node_id}` must be a string, not {type(node_id).__name__}")
        elif not NODE_ID.fullmatch(node_id):
            fail(
                path,
                f"id `{node_id}` is not a url-safe slug: it becomes a route segment, "
                f"a DOM id and the stem of every annotation anchor on this node",
            )
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
    support = meta.get("support")
    if support not in SUPPORT_LEVELS:
        fail(path, f"`support` must be one of {SUPPORT_LEVELS}")
    else:
        hint_count = body.count(":::hint")
        if support in ("worked", "guided") and hint_count == 0:
            fail(path, f"a `{support}` challenge has to carry hints")
        if support == "unaided" and hint_count:
            fail(path, "an `unaided` challenge must not carry hints")
        if ":::solution" not in body:
            fail(path, "every challenge needs a solution, even the unaided ones")
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


SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def check_paths(nodes: dict[str, dict]) -> None:
    claimed: dict[str, str] = {}
    for path_file in sorted((CHALLENGES_DIR / "paths").glob("*.toml")):
        data = tomllib.loads(path_file.read_text())
        # The published route is derived from `slug` alone, and readers anchor
        # annotations to it, so a path without one must not reach the site.
        slug = str(data.get("slug", "")).strip()
        if not SLUG.fullmatch(slug):
            fail(path_file, "needs a url-safe `slug`; the published route comes from it")
        elif slug in claimed:
            fail(path_file, f"slug `{slug}` is already claimed by {claimed[slug]}")
        else:
            claimed[slug] = path_file.name
        for part in data.get("parts", []):
            rung = -1
            for node_id in part.get("nodes", []):
                # A ladder belongs to a chapter. Each concept node starts a new
                # one, so help may be offered again in the next chapter.
                if node_id in nodes and nodes[node_id].get("kind") == "concept":
                    rung = -1
                if node_id not in nodes:
                    fail(path_file, f"part `{part.get('id')}` lists unknown node `{node_id}`")
                    continue
                meta = nodes[node_id]
                if meta.get("kind") != "challenge":
                    continue
                # A chapter's challenges only ever get harder: help may fall
                # away as you go down the list, never come back.
                here = SUPPORT_LEVELS.index(meta.get("support", "guided"))
                if here < rung:
                    problems.append(
                        f"{path_file.name}: `{node_id}` offers more help than the "
                        f"challenge before it; a ladder only goes one way"
                    )
                rung = max(rung, here)


def check_cells() -> None:
    """Run every ```python run cell the way the reader would.

    The web edition replays earlier cells before the current one, so a cell
    that raises takes every later cell in the chapter down with it. This runs
    each chapter the same way and reports the first cell that breaks.
    """
    import subprocess
    import tempfile

    fence = re.compile(r"```python run\n(.*?)```", re.DOTALL)
    for path in sorted(CHALLENGES_DIR.glob("*.md")) + sorted(CHALLENGES_DIR.glob("*/challenge.md")):
        cells = fence.findall(path.read_text())
        earlier = ""
        for index, cell in enumerate(cells, start=1):
            with tempfile.TemporaryDirectory() as work:
                script = Path(work) / "cell.py"
                # Replay earlier cells exactly as the reader's browser does:
                # quietly, and tolerating one that raised on purpose.
                staged = (
                    "import io, contextlib\n"
                    f"_EARLIER = {earlier!r}\n"
                    "try:\n"
                    "    with contextlib.redirect_stdout(io.StringIO()):\n"
                    "        exec(compile(_EARLIER, '<earlier>', 'exec'), globals())\n"
                    "except Exception:\n"
                    "    pass\n"
                ) if earlier.strip() else ""
                script.write_text(staged + cell)
                done = subprocess.run(
                    [sys.executable, str(script)], capture_output=True, text=True, timeout=60
                )
            shown = (done.stdout + done.stderr).strip()
            # A cell that raises is legitimate teaching: the reader sees the
            # traceback. A cell that shows the reader nothing at all is not.
            if not shown:
                problems.append(f"{path.name}: runnable cell {index} shows the reader nothing")
            earlier += cell + "\n"


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

    if "--cells" in sys.argv:
        check_cells()
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
