#!/usr/bin/env python3
"""Render supplied historical *data* with the current trusted book renderer.

No Git, filesystem dependency fallback, network, grader or historical import.
Input hashes validate data consistency, not provenance/approval; the later
collector must authenticate commit-tree bytes. This library bounds inputs and
output, not wall time: its caller must supervise the owned process deadline.
"""
from __future__ import annotations

import hashlib
import html
import json
import math
import re
import sys
from pathlib import Path, PurePosixPath

# Only current reviewed tools enter import resolution, including under -I.
TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import render
import markdown

if Path(render.__file__).resolve() != TOOLS / "render.py" or Path(markdown.__file__).resolve() != TOOLS / "markdown.py":
    raise RuntimeError("current renderer import identity differs")

MAX_BLOB_BYTES = 2 * 1024 * 1024
MAX_MAP_BYTES = 64 * 1024 * 1024
MAX_INPUT_BYTES = 72 * 1024 * 1024
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_FILES = 10_000
MAX_FIGURE_WORK = 1_000_000
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
SUPPORTED_BLOCKS = frozenset((*render.CARD_BLOCKS, "prose", "problem", "figure", "hint", "solution", "run", "exercise"))


def _fail(message: str) -> None:
    raise ValueError(message)


def _text(value: object, limit: int, *, empty: bool = False) -> bytes:
    if type(value) is not str or (not value and not empty) or len(value) > limit:
        _fail("historical text shape or size")
    try:
        data = value.encode("utf-8")
    except UnicodeError:
        _fail("historical text is not UTF8")
    if len(data) > limit:
        _fail("historical text byte limit")
    return data


def _path(value: object) -> str:
    _text(value, 4096)
    if re.search(r"[\\\x00-\x1f\x7f]", value) or any(part in ("", ".", "..") for part in value.split("/")):
        _fail("invalid historical relative path")
    return value


def _object(value: object, fields: set[str]) -> dict:
    if type(value) is not dict or set(value) != fields:
        _fail("historical object shape")
    return value


def _pairs(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for name, value in pairs:
        if name in result:
            _fail("duplicate JSON member")
        result[name] = value
    return result


def _constant(_: str) -> None:
    _fail("nonfinite JSON number")


def _json(raw: bytes) -> object:
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_constant)
    except (UnicodeError, RecursionError, json.JSONDecodeError) as exc:
        raise ValueError("invalid historical JSON") from exc


class HistoricalSource:
    """A bounded immutable copy of supplied data; paths never touch the host."""

    def __init__(self, payload: object):
        value = _object(payload, {"schemaVersion", "sourcePath", "files"})
        if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
            _fail("unknown historical data version")
        self.source_path = _path(value["sourcePath"])
        if re.fullmatch(r"books/(?:chapters/[a-z0-9-]+\.md|challenges/[a-z0-9-]+/challenge\.md)", self.source_path):
            self.chapters, self.challenges, self.figures = "books/chapters", "books/challenges", "books/figures"
        elif re.fullmatch(r"challenges/(?:[a-z0-9-]+\.md|[a-z0-9-]+/challenge\.md)", self.source_path):
            self.chapters, self.challenges, self.figures = "challenges", "challenges", "challenges/figures"
        else:
            _fail("unsupported historical source layout")
        files = value["files"]
        if type(files) is not list or not 1 <= len(files) <= MAX_FILES:
            _fail("historical file count bound")
        self.files: dict[str, dict] = {}
        self.reads: dict[str, dict] = {}
        self.optional_absences: set[str] = set()
        self.figure_work = 0
        self.walk_label_bytes = 0
        size = 0
        for item in files:
            row = _object(item, {"path", "mode", "sha256", "content"})
            path = _path(row["path"])
            data = _text(row["content"], MAX_BLOB_BYTES, empty=True)
            if path in self.files or row["mode"] not in ("100644", "100755"):
                _fail("duplicate or nonregular historical file")
            if type(row["sha256"]) is not str or hashlib.sha256(data).hexdigest() != row["sha256"]:
                _fail("historical data digest mismatch")
            size += len(data)
            if size > MAX_MAP_BYTES:
                _fail("historical map byte bound")
            self.files[path] = dict(row)

    def _read(self, path: str, *, required: bool = True) -> str:
        path = _path(path)
        row = self.files.get(path)
        if row is None:
            if required:
                _fail("required historical dependency is absent")
            self.optional_absences.add(path)
            return ""
        self.reads[path] = {key: row[key] for key in ("path", "mode", "sha256")}
        # Match read_text() universal newline semantics without opening a file.
        return row["content"].replace("\r\n", "\n").replace("\r", "\n")

    def node_at(self, path: str) -> dict:
        meta, body = render.parse_front_matter(self._read(path))
        if not isinstance(meta.get("id"), str) or not SLUG.fullmatch(meta["id"]) or len(meta["id"]) > 128:
            _fail("invalid historical node identifier")
        _text(meta.get("title"), 4096)
        if meta.get("kind") not in ("concept", "challenge"):
            _fail("unsupported historical node kind")
        if meta.get("support", "guided") not in render.SUPPORT_LEVELS:
            _fail("unsupported historical support level")
        # Book ordering/navigation are outside the node-content profile. Never
        # take these derived display values from HEAD or spoofed front matter.
        for name in ("number", "part_number", "part", "chapter_number", "chapter_title", "practice_index", "practice_total"):
            meta.pop(name, None)
        meta["body"] = body
        meta["dir"] = str(PurePosixPath(path).parent) if path.endswith("/challenge.md") else None
        # The canonical parser defines directives; strict history refuses the
        # missing/unknown forms current interactive pages may tolerate.
        position = 0
        while opening := render.BLOCK.search(body, position):
            raw_attrs = (opening.group(2) or "{}")[1:-1]
            consumed = 0
            names = set()
            for attr in render.ATTR.finditer(raw_attrs):
                gap = raw_attrs[consumed:attr.start()]
                if (not re.fullmatch(r"[\s,]*", gap)
                        or (consumed and not gap)
                        or attr.group(1) in names
                        or attr.group(0).count('"') not in (0, 2)):
                    _fail("ambiguous historical directive attributes")
                names.add(attr.group(1))
                consumed = attr.end()
            if not re.fullmatch(r"[\s,]*", raw_attrs[consumed:]):
                _fail("unsupported historical directive attributes")
            closing = render.CLOSING.search(body, opening.end())
            if closing is None:
                _fail("unclosed historical directive")
            position = closing.end()
        for name, attrs, inner in render.split_blocks(body):
            if name not in SUPPORTED_BLOCKS:
                _fail("unsupported historical directive")
            if name in ("problem", "figure", "exercise") and not SLUG.fullmatch(attrs.get("id", "")):
                _fail("invalid historical dependency identifier")
            if name == "exercise" and any(key not in render.parse_exercise(inner) for key in render.EXERCISE_PARTS):
                _fail("incomplete historical exercise")
        return meta

    def load_node(self, node_id: str) -> dict:
        if not SLUG.fullmatch(node_id) or len(node_id) > 128:
            _fail("invalid referenced historical node")
        candidates = [f"{self.chapters}/{node_id}.md", f"{self.challenges}/{node_id}/challenge.md"]
        matches = [path for path in candidates if path in self.files]
        if len(matches) != 1:
            _fail("missing or ambiguous historical referenced node")
        node = self.node_at(matches[0])
        if node["id"] != node_id:
            _fail("historical referenced node identity differs")
        return node

    def figure_data(self, figure_id: str) -> dict:
        if not SLUG.fullmatch(figure_id) or len(figure_id) > 128:
            _fail("invalid historical figure identifier")
        data = _json(self._read(f"{self.figures}/{figure_id}.json").encode("utf-8"))
        if type(data) is not dict or data.get("type") not in render.FIGURE_TYPES:
            _fail("unsupported historical figure type")
        stack = [(data, 0)]
        while stack:
            value, depth = stack.pop()
            self.figure_work += 1
            if depth > 8 or self.figure_work > MAX_FIGURE_WORK:
                _fail("historical figure work bound")
            if type(value) is dict:
                stack.extend((item, depth + 1) for item in value.values())
            elif type(value) is list:
                stack.extend((item, depth + 1) for item in value)
            elif type(value) is float and not math.isfinite(value):
                _fail("nonfinite historical figure value")
        # The canonical links/walk drawing has nested loops. Budget that work
        # across all occurrences, not independently for every repeated figure.
        if data["type"] in ("links", "walk"):
            a, b = ("nodes", "edges") if data["type"] == "links" else ("sequence", "state")
            if type(data.get(a, [])) is not list or type(data.get(b, [])) is not list:
                _fail("historical figure array shape")
            self.figure_work += len(data.get(a, [])) * len(data.get(b, []))
            if self.figure_work > MAX_FIGURE_WORK:
                _fail("historical figure work bound")
        if data["type"] == "walk":
            # Static walks repeat each state's label once for every available
            # step. Count those exact bytes before the canonical join; a large
            # label plus many steps must not multiply into unbounded output.
            for state in data.get("state", []):
                if type(state) is not dict or type(state.get("values", [])) is not list:
                    _fail("historical walk state shape")
                steps = min(len(data.get("sequence", [])), len(state.get("values", [])))
                self.walk_label_bytes += steps * len(html.escape(str(state.get("label", ""))).encode("utf-8"))
                if self.walk_label_bytes > MAX_OUTPUT_BYTES:
                    _fail("historical walk output byte bound")
        return data

    def starter_text(self, node: dict, attrs: dict) -> str:
        name = _path(attrs.get("starter", "starter.py"))
        folder = node.get("dir")
        if folder is None:
            if "starter" in attrs:
                _fail("explicit historical starter has no challenge directory")
            return ""
        # Strict history: explicit reference must exist. The canonical implicit
        # default remains optional, with an absence witness instead of fallback.
        return self._read(f"{_path(folder)}/{name}", required="starter" in attrs)


def render_history(payload: object) -> dict:
    source = HistoricalSource(payload)
    try:
        node = source.node_at(source.source_path)
        markup = render.render_node(node, "web", source=source, read_only=True,
                                    max_output_bytes=MAX_OUTPUT_BYTES)
        result = {
            "schemaVersion": 1,
            "profile": "node-content-readonly-v1",
            "sourcePath": source.source_path,
            "sourceSha256": source.files[source.source_path]["sha256"],
            "html": markup,
            "blocks": [{"kind": kind, "id": identifier, "digest": digest}
                       for kind, digest, identifier in render.BLOCK_TAG.findall(markup)],
            "reads": [source.reads[path] for path in sorted(source.reads)],
            "optionalAbsences": sorted(source.optional_absences),
        }
        if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > MAX_OUTPUT_BYTES:
            _fail("historical output byte bound")
        return result
    except (KeyError, TypeError, AttributeError, IndexError, OverflowError, RecursionError) as exc:
        raise ValueError("historical content cannot be rendered by the current profile") from exc


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            _fail("historical input byte bound")
        result = render_history(_json(raw))
        output = (json.dumps(result, ensure_ascii=False) + "\n").encode("utf-8")
        if len(output) > MAX_OUTPUT_BYTES:
            _fail("historical output byte bound")
    except (ValueError, OSError):
        # No source content, paths, parser excerpt or traceback enters logs.
        sys.stderr.write("historical rendering unavailable: invalid or unsupported bounded data\n")
        return 2
    sys.stdout.buffer.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
