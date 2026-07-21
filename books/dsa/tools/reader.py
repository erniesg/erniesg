#!/usr/bin/env python3
"""Local reading and exercise surface for the executable DSA book.

The server binds to loopback only, renders the authored chapter Markdown, and
grades code with the same subprocess-isolated tiers as ``runner.py``.

Usage:
  python3 book/tools/reader.py
  python3 book/tools/reader.py --no-open --port 8765
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import secrets
import shutil
import threading
import webbrowser
from dataclasses import asdict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import runner
import publication


WEB_DIR = runner.BOOK_DIR / "web"
MAX_REQUEST_BYTES = 1_000_000
TIER_EXPLANATIONS = {
    "public": "Visible examples",
    "edge": "Boundary cases",
    "stress": "Randomized referee",
    "perf": "Large input under time",
}


class ReaderError(Exception):
    """A request error that can be shown safely to the local reader."""

    def __init__(self, message: str, status: int = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


def _frontmatter(markdown: str) -> tuple[dict[str, str], str]:
    lines = markdown.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, markdown
    metadata: dict[str, str] = {}
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return metadata, "\n".join(lines[index + 1 :])
        key, separator, value = line.partition(":")
        if separator:
            metadata[key.strip()] = value.strip()
    return {}, markdown


def _inline(text: str) -> str:
    """Render the small, authored inline-Markdown subset used by chapters."""
    escaped = html.escape(text, quote=True)
    code: list[str] = []

    def stash_code(match: re.Match[str]) -> str:
        code.append(f"<code>{match.group(1)}</code>")
        return f"\x00CODE{len(code) - 1}\x00"

    escaped = re.sub(r"`([^`]+)`", stash_code, escaped)
    escaped = re.sub(
        r"\[([^]]+)]\((https?://[^\s)]+|/[^\s)]*|#[^\s)]*)\)",
        r'<a href="\2">\1</a>',
        escaped,
    )
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", escaped)
    for index, fragment in enumerate(code):
        escaped = escaped.replace(f"\x00CODE{index}\x00", fragment)
    return escaped


def _is_table_separator(line: str) -> bool:
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def _table_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def render_markdown(markdown: str) -> str:
    """Render a safe, dependency-free subset of Markdown for book chapters."""
    _, body = _frontmatter(markdown)
    lines = body.splitlines()
    output: list[str] = []
    paragraph: list[str] = []
    list_kind: str | None = None
    list_items: list[list[str]] = []

    def flush_paragraph() -> None:
        if paragraph:
            output.append(f"<p>{_inline(' '.join(part.strip() for part in paragraph))}</p>")
            paragraph.clear()

    def flush_list() -> None:
        nonlocal list_kind
        if not list_kind:
            return
        tag = "ol" if list_kind == "ol" else "ul"
        items = "".join(
            f"<li>{_inline(' '.join(part.strip() for part in item))}</li>"
            for item in list_items
        )
        output.append(f"<{tag}>{items}</{tag}>")
        list_items.clear()
        list_kind = None

    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if stripped.startswith("```"):
            flush_paragraph()
            flush_list()
            language = stripped[3:].strip()
            code_lines: list[str] = []
            index += 1
            while index < len(lines) and not lines[index].strip().startswith("```"):
                code_lines.append(lines[index])
                index += 1
            language_class = (
                f' class="language-{html.escape(language, quote=True)}"'
                if language
                else ""
            )
            output.append(
                f"<pre><code{language_class}>{html.escape(chr(10).join(code_lines))}</code></pre>"
            )
            index += 1
            continue

        if (
            stripped.startswith("|")
            and index + 1 < len(lines)
            and _is_table_separator(lines[index + 1])
        ):
            flush_paragraph()
            flush_list()
            headers = _table_cells(line)
            index += 2
            rows: list[list[str]] = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                rows.append(_table_cells(lines[index]))
                index += 1
            head = "".join(f"<th>{_inline(cell)}</th>" for cell in headers)
            body_rows = "".join(
                "<tr>" + "".join(f"<td>{_inline(cell)}</td>" for cell in row) + "</tr>"
                for row in rows
            )
            output.append(
                f'<div class="table-wrap"><table><thead><tr>{head}</tr></thead>'
                f"<tbody>{body_rows}</tbody></table></div>"
            )
            continue

        heading = re.match(r"^(#{1,4})\s+(.+)$", stripped)
        if heading:
            flush_paragraph()
            flush_list()
            level = len(heading.group(1))
            label = heading.group(2)
            anchor = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
            output.append(f'<h{level} id="{anchor}">{_inline(label)}</h{level}>')
            index += 1
            continue

        ordered = re.match(r"^\d+\.\s+(.+)$", stripped)
        unordered = re.match(r"^[-*]\s+(.+)$", stripped)
        if ordered or unordered:
            flush_paragraph()
            kind = "ol" if ordered else "ul"
            if list_kind and list_kind != kind:
                flush_list()
            list_kind = kind
            list_items.append([(ordered or unordered).group(1)])
            index += 1
            continue

        if stripped.startswith("> "):
            flush_paragraph()
            flush_list()
            output.append(f"<blockquote>{_inline(stripped[2:])}</blockquote>")
            index += 1
            continue

        if not stripped:
            flush_paragraph()
            flush_list()
            index += 1
            continue

        if list_kind and list_items:
            list_items[-1].append(stripped)
        else:
            paragraph.append(stripped)
        index += 1

    flush_paragraph()
    flush_list()
    return "\n".join(output)


def _tail(output: str, line_count: int = 28) -> str:
    lines = output.splitlines()
    return "\n".join(lines[-line_count:])


class ReaderApp:
    """Book discovery, source persistence, and grading independent of HTTP."""

    def __init__(self) -> None:
        self._grade_lock = threading.Lock()

    @staticmethod
    def _chapter(chapter_id: str) -> runner.Chapter:
        for chapter in runner.discover_chapters():
            if chapter.id == chapter_id or chapter.slug == chapter_id:
                return chapter
        raise ReaderError(f"No chapter named {chapter_id!r}.", HTTPStatus.NOT_FOUND)

    @staticmethod
    def _source_path(chapter: runner.Chapter) -> Path:
        return chapter.workspace / f"{chapter.module}.py"

    @staticmethod
    def _starter_path(chapter: runner.Chapter) -> Path:
        return chapter.path / "starter" / f"{chapter.module}.py"

    def _source(self, chapter: runner.Chapter) -> str:
        source_path = self._source_path(chapter)
        path = source_path if source_path.is_file() else self._starter_path(chapter)
        return path.read_text()

    @staticmethod
    def _progress_summary(progress: dict) -> dict:
        return {
            "xp": progress["xp"],
            "badges": progress["badges"],
            "streak": progress["streak"]["days"],
        }

    def chapters(self) -> dict:
        metadata = publication.load_metadata()
        progress = runner.load_progress()
        chapters = []
        for position, chapter in enumerate(runner.discover_chapters(), start=1):
            markdown = (chapter.path / "chapter.md").read_text()
            chapter_metadata, _ = _frontmatter(markdown)
            state = progress["chapters"].get(chapter.id, {})
            passed = [
                tier.name
                for tier in chapter.tiers
                if state.get(tier.name, {}).get("passed")
            ]
            chapters.append(
                {
                    "id": chapter.id,
                    "slug": chapter.slug,
                    "number": position,
                    "title": chapter.title,
                    "part": chapter_metadata.get("part", "I"),
                    "tiers": [tier.name for tier in chapter.tiers],
                    "passed": passed,
                    "complete": len(passed) == len(chapter.tiers),
                }
            )
        return {
            "book": {
                "title": metadata.title,
                "shortTitle": metadata.short_title,
                "subtitle": metadata.subtitle,
                "author": metadata.author,
                "publisher": metadata.publisher,
                "description": metadata.description,
                "edition": metadata.edition,
                "epubFilename": publication.epub_filename(metadata),
                "parts": [asdict(part) for part in metadata.parts],
            },
            "chapters": chapters,
            "progress": self._progress_summary(progress),
        }

    def book(self) -> dict:
        index = self.chapters()
        preface = (publication.FRONTMATTER_DIR / "preface.md").read_text()
        index["prefaceHtml"] = render_markdown(preface)
        index["prefaceSections"] = publication.headings(preface)
        return index

    def chapter(self, chapter_id: str) -> dict:
        chapter = self._chapter(chapter_id)
        markdown = (chapter.path / "chapter.md").read_text()
        metadata, _ = _frontmatter(markdown)
        words = len(re.findall(r"\b\w+\b", markdown))
        source_path = self._source_path(chapter)
        try:
            displayed_source_path = str(source_path.relative_to(runner.BOOK_DIR.parent))
        except ValueError:
            displayed_source_path = source_path.name
        return {
            "id": chapter.id,
            "slug": chapter.slug,
            "title": chapter.title,
            "part": metadata.get("part", "I"),
            "edition": metadata.get("edition", "0.1.0"),
            "readingMinutes": max(1, round(words / 220)),
            "html": render_markdown(markdown),
            "sections": publication.headings(markdown),
            "source": self._source(chapter),
            "sourcePath": displayed_source_path,
            "tiers": [
                {
                    **asdict(tier),
                    "test_file": str(tier.test_file.relative_to(runner.BOOK_DIR.parent)),
                    "description": TIER_EXPLANATIONS[tier.name],
                }
                for tier in chapter.tiers
            ],
        }

    def grade(self, chapter_id: str, source: str) -> dict:
        if not isinstance(source, str) or not source.strip():
            raise ReaderError("Write some Python before running the grader.")
        if len(source.encode()) > MAX_REQUEST_BYTES:
            raise ReaderError("The submitted source is too large.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)

        chapter = self._chapter(chapter_id)
        with self._grade_lock:
            chapter.workspace.mkdir(parents=True, exist_ok=True)
            source_path = self._source_path(chapter)
            temporary = source_path.with_suffix(".py.tmp")
            temporary.write_text(source)
            os.replace(temporary, source_path)

            progress = runner.load_progress()
            results = []
            earned_badges: list[str] = []
            for tier in chapter.tiers:
                outcome, output = runner.run_tier(chapter, tier, chapter.workspace)
                result = {
                    "tier": tier.name,
                    "outcome": outcome,
                    "xp": tier.xp,
                    "output": _tail(output) if output else "All checks passed.",
                }
                results.append(result)
                if outcome == "pass":
                    earned_badges.extend(runner.record_pass(progress, chapter, tier))
                else:
                    break
            runner.save_progress(progress)
            return {
                "ok": len(results) == len(chapter.tiers)
                and all(result["outcome"] == "pass" for result in results),
                "results": results,
                "earnedBadges": earned_badges,
                "progress": self._progress_summary(progress),
            }

    def reset(self, chapter_id: str) -> dict:
        chapter = self._chapter(chapter_id)
        with self._grade_lock:
            chapter.workspace.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self._starter_path(chapter), self._source_path(chapter))
        return {"source": self._source(chapter)}


class BookServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], app: ReaderApp, token: str):
        super().__init__(address, BookRequestHandler)
        self.app = app
        self.token = token


class BookRequestHandler(BaseHTTPRequestHandler):
    server: BookServer
    server_version = "RucksackBook/0.1"

    def log_message(self, format: str, *args) -> None:
        print(f"reader: {self.address_string()} — {format % args}")

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        )

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _json(self, value: object, status: int = HTTPStatus.OK) -> None:
        self._send(
            status,
            json.dumps(value, ensure_ascii=False).encode(),
            "application/json; charset=utf-8",
        )

    def _error(self, error: ReaderError | Exception) -> None:
        if isinstance(error, ReaderError):
            self._json({"error": str(error)}, error.status)
        else:
            self._json({"error": "The local reader hit an unexpected error."}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _authorized(self) -> bool:
        supplied = self.headers.get("X-Book-Token", "")
        return secrets.compare_digest(supplied, self.server.token)

    def _body(self) -> dict:
        length_header = self.headers.get("Content-Length")
        if not length_header:
            raise ReaderError("Missing request body.")
        try:
            length = int(length_header)
        except ValueError as error:
            raise ReaderError("Invalid request length.") from error
        if length < 0:
            raise ReaderError("Invalid request length.")
        if length > MAX_REQUEST_BYTES:
            raise ReaderError("The request is too large.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ReaderError("Expected a JSON request body.") from error
        if not isinstance(value, dict):
            raise ReaderError("Expected a JSON object.")
        return value

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        try:
            path = unquote(urlparse(self.path).path)
            if path == "/api/chapters":
                self._json(self.server.app.chapters())
                return
            if path == "/api/book":
                self._json(self.server.app.book())
                return
            if path.startswith("/api/chapters/"):
                self._json(self.server.app.chapter(path.rsplit("/", 1)[-1]))
                return
            if path in {"/", "/index.html"}:
                template = (WEB_DIR / "index.html").read_text()
                document = template.replace("__BOOK_TOKEN__", self.server.token).encode()
                self._send(HTTPStatus.OK, document, "text/html; charset=utf-8")
                return
            if path == "/book.epub":
                payload = publication.build_epub(render_markdown)
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", publication.MIMETYPE)
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{publication.epub_filename()}"',
                )
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self._security_headers()
                self.end_headers()
                self.wfile.write(payload)
                return
            static_files = {
                "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                "/styles.css": ("styles.css", "text/css; charset=utf-8"),
            }
            if path in static_files:
                filename, content_type = static_files[path]
                self._send(HTTPStatus.OK, (WEB_DIR / filename).read_bytes(), content_type)
                return
            raise ReaderError("Not found.", HTTPStatus.NOT_FOUND)
        except Exception as error:  # request boundary
            self._error(error)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        try:
            if not self._authorized():
                raise ReaderError("This request did not come from the local book reader.", HTTPStatus.FORBIDDEN)
            if self.headers.get_content_type() != "application/json":
                raise ReaderError("Expected application/json.", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            body = self._body()
            path = urlparse(self.path).path
            if path == "/api/grade":
                self._json(self.server.app.grade(str(body.get("chapter", "")), body.get("source")))
                return
            if path == "/api/reset":
                self._json(self.server.app.reset(str(body.get("chapter", ""))))
                return
            raise ReaderError("Not found.", HTTPStatus.NOT_FOUND)
        except Exception as error:  # request boundary
            self._error(error)


def create_server(port: int = 8765, token: str | None = None) -> BookServer:
    return BookServer(("127.0.0.1", port), ReaderApp(), token or secrets.token_urlsafe(24))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true", help="do not open the browser automatically")
    args = parser.parse_args(argv)

    requested_port = args.port
    try:
        server = create_server(requested_port)
    except OSError as error:
        if error.errno not in {48, 98, 10048}:  # macOS, Linux, Windows address-in-use
            raise
        server = create_server(0)
        print(f"Port {requested_port} is in use; selected {server.server_port} instead.")
    url = f"http://127.0.0.1:{server.server_port}"
    print("\nThe Rucksack Book of Data Structures & Algorithms")
    print(f"Read and run it at: {url}")
    print("Press Ctrl-C to stop.\n")
    if not args.no_open:
        threading.Timer(0.25, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nReader stopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
