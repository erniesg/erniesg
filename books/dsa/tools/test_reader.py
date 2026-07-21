"""Tests for the local executable-book reading surface."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))

import reader
import runner


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
