"""Tests for the local executable-book reading surface."""

from __future__ import annotations

import json
import io
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))

import reader
import runner
import publication


class MarkdownRenderingTests(unittest.TestCase):
    def test_renders_book_markdown_and_removes_frontmatter(self):
        rendered = reader.render_markdown(
            """---
id: ch99
---
# A chapter

Read **carefully** and call `solve()`.

1. First step
2. Second step

| Tier | Meaning |
| --- | --- |
| public | examples |

```python
def solve():
    return 1
```
"""
        )
        self.assertNotIn("id: ch99", rendered)
        self.assertIn('<h1 id="a-chapter">A chapter</h1>', rendered)
        self.assertIn("<strong>carefully</strong>", rendered)
        self.assertIn("<code>solve()</code>", rendered)
        self.assertIn("<ol><li>First step</li><li>Second step</li></ol>", rendered)
        self.assertIn("<table>", rendered)
        self.assertIn('class="language-python"', rendered)

    def test_escapes_authored_html_and_rejects_unsafe_link_schemes(self):
        rendered = reader.render_markdown(
            "A <script>alert(1)</script> and [bad](javascript:alert(1))."
        )
        self.assertNotIn("<script>", rendered)
        self.assertIn("&lt;script&gt;", rendered)
        self.assertNotIn('href="javascript:', rendered)


class PublicationTests(unittest.TestCase):
    def test_book_metadata_and_table_of_contents_are_canonical(self):
        metadata = publication.load_metadata()
        self.assertEqual(metadata.publisher, "Ernie.SG Study")
        self.assertEqual(metadata.parts[0].title, "Learning to measure")
        sections = publication.headings(
            (runner.CHAPTERS_DIR / "ch01-what-an-algorithm-is" / "chapter.md").read_text()
        )
        self.assertIn("The challenge: add", [section["label"] for section in sections])

    def test_epub_has_uncompressed_mimetype_navigation_and_valid_xml(self):
        payload = publication.build_epub(reader.render_markdown)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            names = archive.namelist()
            self.assertEqual(names[0], "mimetype")
            self.assertEqual(archive.read("mimetype"), b"application/epub+zip")
            self.assertEqual(archive.getinfo("mimetype").compress_type, zipfile.ZIP_STORED)
            navigation = archive.read("OEBPS/nav.xhtml").decode()
            self.assertIn("How to read this book", navigation)
            self.assertIn("Tests as executable definitions", navigation)
            cover = archive.read("OEBPS/cover.svg").decode()
            self.assertIn("#d8ff47", cover)
            self.assertIn(">RUCKSACK</text>", cover)
            self.assertNotIn("R/ RUCKSACK", cover)
            for name in names:
                if name.endswith((".xhtml", ".xml", ".opf", ".svg")):
                    ElementTree.fromstring(archive.read(name))


class IsolatedReaderTestCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.original_workspace = runner.WORKSPACE_DIR
        self.original_progress = runner.PROGRESS_PATH
        root = Path(self.temporary.name)
        runner.WORKSPACE_DIR = root / "workspace"
        runner.PROGRESS_PATH = root / "progress.json"

    def tearDown(self):
        runner.WORKSPACE_DIR = self.original_workspace
        runner.PROGRESS_PATH = self.original_progress
        self.temporary.cleanup()


class ReaderAppTests(IsolatedReaderTestCase):
    def test_lists_and_loads_authored_chapters(self):
        app = reader.ReaderApp()
        index = app.chapters()
        self.assertEqual([chapter["id"] for chapter in index["chapters"]], ["ch01", "ch02", "ch03"])
        chapter = app.chapter("ch01")
        self.assertEqual(chapter["title"], "What an algorithm actually is")
        self.assertIn("The challenge", chapter["html"])
        self.assertIn("return 0", chapter["source"])
        self.assertEqual([tier["name"] for tier in chapter["tiers"]], runner.TIER_ORDER)

    def test_grades_code_with_existing_tiers_and_records_progress(self):
        app = reader.ReaderApp()
        result = app.grade(
            "ch01",
            "def add(a: int, b: int) -> int:\n    return a + b\n",
        )
        self.assertTrue(result["ok"])
        self.assertEqual([entry["outcome"] for entry in result["results"]], ["pass"] * 4)
        self.assertEqual(result["progress"]["xp"], 70)
        self.assertIn("first-green", result["progress"]["badges"])
        self.assertTrue((runner.WORKSPACE_DIR / "ch01" / "warmup.py").is_file())

    def test_reset_restores_the_pristine_starter(self):
        app = reader.ReaderApp()
        app.grade("ch01", "def add(a, b):\n    return a + b\n")
        reset = app.reset("ch01")
        self.assertIn("return 0", reset["source"])


class ReaderHttpTests(IsolatedReaderTestCase):
    def setUp(self):
        super().setUp()
        self.server = reader.create_server(0, "reader-test-session")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        super().tearDown()

    def test_serves_reader_and_chapter_index(self):
        with urlopen(f"{self.base_url}/", timeout=2) as response:
            document = response.read().decode()
            self.assertIn("reader-test-session", document)
            self.assertEqual(response.headers["X-Frame-Options"], "DENY")
        with urlopen(f"{self.base_url}/api/chapters", timeout=2) as response:
            payload = json.load(response)
            self.assertEqual(len(payload["chapters"]), 3)
            self.assertEqual(payload["book"]["publisher"], "Ernie.SG Study")
        with urlopen(f"{self.base_url}/book.epub", timeout=2) as response:
            self.assertEqual(response.headers.get_content_type(), "application/epub+zip")
            self.assertTrue(response.read().startswith(b"PK"))
        with urlopen(f"{self.base_url}/assets/rucksack-lockup-on-light.svg", timeout=2) as response:
            self.assertEqual(response.headers.get_content_type(), "image/svg+xml")
            self.assertIn(b"#d8ff47", response.read())
        with urlopen(f"{self.base_url}/assets/rucksack-lockup-on-dark.svg", timeout=2) as response:
            self.assertEqual(response.headers.get_content_type(), "image/svg+xml")
            self.assertIn(b"#f7f5ed", response.read())

    def test_write_endpoint_requires_session_token(self):
        request = Request(
            f"{self.base_url}/api/reset",
            data=json.dumps({"chapter": "ch01"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(HTTPError) as context:
            urlopen(request, timeout=2)
        self.assertEqual(context.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
