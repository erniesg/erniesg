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
