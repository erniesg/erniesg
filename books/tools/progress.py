"""What a reader has finished, in the one shape every edition shares.

The Python half of `runtime/progress.mjs`: the local preview reads and writes
`books/workspace/progress.json` with these, and the browser code reads the
same shape, so "Export progress" on the site and this file are
interchangeable. `runtime/progress-fixtures.json` holds both halves to the
same rules:

- `solved` is the union of both copies, with the earliest known solve time;
- a draft is whichever was written last, the first copy winning a tie;
- anything invalid is dropped rather than repaired, and unreadable input is
  empty progress, never an exception.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

VERSION = 1
MAX_DRAFT_LENGTH = 20000
ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,127}$")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$")


def is_item_id(value) -> bool:
    return isinstance(value, str) and bool(ID.match(value))


def _moment(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def is_timestamp(value) -> bool:
    if not isinstance(value, str) or not ISO.match(value):
        return False
    try:
        _moment(value)
    except ValueError:
        return False
    return True


def empty(book: str) -> dict:
    return {"version": VERSION, "book": book, "solved": [], "solvedAt": {}, "drafts": {}}


def _length(code: str) -> int:
    # JavaScript measures strings in UTF-16 code units; so must the cap.
    return len(code.encode("utf-16-le")) // 2


def normalize(raw, book: str) -> dict:
    data = empty(book)
    if not isinstance(raw, dict):
        return data
    solved = raw.get("solved")
    data["solved"] = sorted({item for item in solved if is_item_id(item)}) if isinstance(solved, list) else []
    solved_at = raw.get("solvedAt") if isinstance(raw.get("solvedAt"), dict) else {}
    data["solvedAt"] = {
        item: solved_at[item] for item in data["solved"] if is_timestamp(solved_at.get(item))
    }
    drafts = raw.get("drafts") if isinstance(raw.get("drafts"), dict) else {}
    for item in sorted(drafts):
        draft = drafts[item]
        if not is_item_id(item) or not isinstance(draft, dict):
            continue
        code = draft.get("code")
        if not isinstance(code, str) or _length(code) > MAX_DRAFT_LENGTH:
            continue
        if not is_timestamp(draft.get("updatedAt")):
            continue
        data["drafts"][item] = {"code": code, "updatedAt": draft["updatedAt"]}
    return data


def _earlier(left, right):
    if not left:
        return right
    if not right:
        return left
    return right if _moment(right) < _moment(left) else left


def merge(a, b) -> dict:
    book = a.get("book", "") if isinstance(a, dict) and isinstance(a.get("book"), str) else ""
    left, right = normalize(a, book), normalize(b, book)
    merged = empty(book)
    merged["solved"] = sorted(set(left["solved"]) | set(right["solved"]))
    for item in merged["solved"]:
        at = _earlier(left["solvedAt"].get(item), right["solvedAt"].get(item))
        if at:
            merged["solvedAt"][item] = at
    for item in sorted(set(left["drafts"]) | set(right["drafts"])):
        mine, theirs = left["drafts"].get(item), right["drafts"].get(item)
        if mine and (not theirs or _moment(mine["updatedAt"]) >= _moment(theirs["updatedAt"])):
            merged["drafts"][item] = mine
        else:
            merged["drafts"][item] = theirs
    return merged


def mark_solved(data: dict, item: str, now: str) -> dict:
    if not is_item_id(item) or item in data["solved"]:
        return data
    return {
        **data,
        "solved": sorted([*data["solved"], item]),
        "solvedAt": dict(sorted({**data["solvedAt"], item: now}.items())),
    }


def read_file(path: Path, book: str) -> dict:
    try:
        return normalize(json.loads(path.read_text()), book)
    except (OSError, ValueError):
        return empty(book)


def write_file(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(normalize(data, data.get("book", "")), indent=2) + "\n")
