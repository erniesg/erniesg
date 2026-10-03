"""preview.py: node pages carry the pager, the chapter indicator and its runtime.

    python3 -m unittest discover -s books/tools -p 'test_*.py'
"""

from __future__ import annotations

import re
import sys
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import preview


class NodePages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), preview.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, route: str, solved: list[str]) -> str:
        # Never the reader's real progress.json.
        with mock.patch.object(preview, "read_progress", return_value={"solved": solved}):
            with urllib.request.urlopen(self.base + route, timeout=30) as response:
                return response.read().decode()

    def test_a_solved_practice_is_ticked_in_the_bar(self):
        page = self.get("/fridge-alarm", ["pool-ticket-price"])
        bar = re.search(r'<header class="top">.*?</header>', page, re.DOTALL).group(0)
        self.assertIn("data-chapter-progress", bar)
        self.assertIn("Practice 2 of 2 · 1/2 solved", bar)
        solved = re.search(r'<a [^>]*data-cp-practice="pool-ticket-price"[^>]*>', bar).group(0)
        self.assertIn("data-progress-done", solved)

    def test_the_pager_follows_the_text_and_the_runtime_is_inlined(self):
        page = self.get("/ch02-conditionals", [])
        self.assertIn('class="book-pager"', page)
        self.assertIn('rel="next" href="/pool-ticket-price"', page)
        self.assertIn("export function installBookKeys", page)
        self.assertIn("installBookKeys(document); trackChapterProgress(document);", page)

    def test_the_contents_page_has_the_front_bar_not_a_chapter_indicator(self):
        # "Contents · x/y solved" and › to the first page, as on the site; no
        # chapter, so no track of sections.
        page = self.get("/", ["pool-ticket-price"])
        self.assertIn('data-kind="front"', page)
        self.assertIn(">1/30 solved<", page)
        self.assertNotIn('class="cp-track"', page)
        self.assertIn("installBookKeys(document); trackChapterProgress(document);", page)


if __name__ == "__main__":
    unittest.main()
