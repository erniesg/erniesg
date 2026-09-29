"""preview.py: the local server's JSON routes and the output it hands back.

    python3 -m unittest discover -s books/tools -p 'test_*.py'
"""

from __future__ import annotations

import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path, PurePosixPath, PureWindowsPath
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import preview


class JsonRoutes(unittest.TestCase):
    """Rule: every response on /api/exec and /api/grade carries a boolean `ok`."""

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

    def post(self, route: str, body: bytes) -> dict:
        request = urllib.request.Request(
            self.base + route, data=body, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            return json.loads(error.read())

    def exec(self, source: str) -> dict:
        return self.post("/api/exec", json.dumps({"source": source, "earlier": []}).encode())

    def test_every_exec_path_has_an_outcome(self):
        with mock.patch.object(preview, "EXEC_TIMEOUT_SECONDS", 1):
            cases = {
                "clean": (self.exec("print('hi')"), True),
                "raises": (self.exec("{}['missing']"), False),
                "times out": (self.exec("while True: pass"), False),
                "unreadable": (self.post("/api/exec", b"{not json"), False),
                "not an object": (self.post("/api/exec", b"[1, 2]"), False),
            }
        for name, (result, ok) in cases.items():
            with self.subTest(name):
                self.assertIs(result.get("ok"), ok, result)
                self.assertIsInstance(result.get("output"), str)
        self.assertIn("stopped after 1 seconds", cases["times out"][0]["output"])

    def test_every_grade_path_has_an_outcome(self):
        for name, body in {
            "unreadable": b"{not json",
            "unknown challenge": json.dumps({"node": "no-such-challenge"}).encode(),
        }.items():
            with self.subTest(name):
                result = self.post("/api/grade", body)
                self.assertIs(result.get("ok"), False, result)
                self.assertEqual(result.get("tiers"), [])


class ProgressRoutes(unittest.TestCase):
    """The page code the site runs is served here, and progress round-trips by merging."""

    def setUp(self):
        import tempfile

        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        patcher = mock.patch.object(preview, "PROGRESS_PATH", Path(self.directory.name) / "progress.json")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), preview.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def fetch(self, route: str, body: bytes | None = None) -> tuple[int, bytes, str]:
        request = urllib.request.Request(
            self.base + route, data=body, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, response.read(), response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers.get("Content-Type", "")

    def test_the_runtime_modules_are_served_and_nothing_else_is(self):
        for name in ("progress.mjs", "exercises.mjs", "book-progress.mjs"):
            with self.subTest(name):
                status, body, kind = self.fetch(f"/runtime/{name}")
                self.assertEqual(status, 200)
                self.assertIn("javascript", kind)
                self.assertEqual(body, (preview.RUNTIME / name).read_bytes())
        for route in ("/runtime/../preview.py", "/runtime/progress-fixtures.json", "/runtime/nope.mjs"):
            with self.subTest(route):
                self.assertEqual(self.fetch(route)[0], 404)

    def test_progress_merges_and_never_forgets_a_solve(self):
        preview.PROGRESS_PATH.write_text(json.dumps({"solved": ["sum-of-two-digits"]}))
        status, body, _ = self.fetch("/api/progress")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["solved"], ["sum-of-two-digits"])

        upload = {
            "version": 1, "book": "build-a-coding-agent", "solved": ["ch03-last-three"],
            "solvedAt": {"ch03-last-three": "2026-09-28T09:00:00.000Z"},
            "drafts": {"ch03-one-copy": {"code": "print(1)", "updatedAt": "2026-09-28T09:00:00.000Z"}},
        }
        status, body, _ = self.fetch("/api/progress", json.dumps(upload).encode())
        self.assertEqual(status, 200)
        merged = json.loads(body)
        self.assertEqual(merged["solved"], ["ch03-last-three", "sum-of-two-digits"])
        on_disk = json.loads(preview.PROGRESS_PATH.read_text())
        self.assertEqual(on_disk, merged)
        self.assertEqual(on_disk["drafts"]["ch03-one-copy"]["code"], "print(1)")

        # An upload that knows less removes nothing.
        status, body, _ = self.fetch("/api/progress", json.dumps({"solved": []}).encode())
        self.assertEqual(json.loads(body)["solved"], ["ch03-last-three", "sum-of-two-digits"])

    def test_an_unreadable_upload_is_refused_and_changes_nothing(self):
        preview.PROGRESS_PATH.write_text(json.dumps({"solved": ["sum-of-two-digits"]}))
        for body in (b"{not json", b"[1, 2]"):
            with self.subTest(body):
                self.assertEqual(self.fetch("/api/progress", body)[0], 400)
        self.assertEqual(json.loads(preview.PROGRESS_PATH.read_text()), {"solved": ["sum-of-two-digits"]})

    def test_every_page_loads_the_shared_progress_module_for_this_book(self):
        status, body, _ = self.fetch("/ch03-lists")
        self.assertEqual(status, 200)
        self.assertIn(b"import { startProgress } from '/runtime/book-progress.mjs'", body)
        self.assertIn(b'book: "build-a-coding-agent"', body)


class StripRoots(unittest.TestCase):
    """Rule: this machine's folders leave grader output on either separator."""

    def test_posix_and_windows_roots_are_both_removed(self):
        for root, output in (
            (PurePosixPath("/home/me/books/workspace"),
             'File "/home/me/books/workspace/a/pairwise.py", line 3'),
            (PureWindowsPath(r"C:\me\books\workspace"),
             r'File "C:\me\books\workspace\a\pairwise.py", line 3'),
            (PureWindowsPath(r"C:\me\books\workspace"),
             'File "C:/me/books/workspace/a/pairwise.py", line 3'),
        ):
            with self.subTest(str(root)):
                stripped = preview.strip_roots(output, (root,))
                self.assertTrue(stripped.startswith('File "a'), stripped)


if __name__ == "__main__":
    unittest.main()


class ChallengeView(unittest.TestCase):
    """The preview hosts the side-by-side view the site does: same markup,
    the view set in <head> before first paint, the shared toggle script."""

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

    def get(self, route: str) -> str:
        with urllib.request.urlopen(self.base + route, timeout=30) as response:
            return response.read().decode()

    def test_a_challenge_page_can_split_and_sets_the_view_before_first_paint(self):
        page = self.get("/pool-ticket-price")
        self.assertIn("data-challenge-split", page)
        head, body = page.split("<body", 1)
        self.assertIn(preview.CHALLENGE_VIEW_HEAD_SCRIPT, head)
        self.assertIn(preview.SPLIT_SCRIPT, body)
        self.assertIn(".challenge-split", head)
