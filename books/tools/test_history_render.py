"""Historical inputs are data for the current canonical renderer, never code."""
from __future__ import annotations

import hashlib
import importlib.util
import inspect
import json
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import render

SOURCE = "books/chapters/example.md"


def document(body: str, kind: str = "concept", identifier: str = "example") -> str:
    return f'+++\nid = "{identifier}"\nkind = "{kind}"\ntitle = "Historical title"\n+++\n{body}'


def payload(body: str, extras: dict[str, str] | None = None, source: str = SOURCE, kind: str = "concept") -> dict:
    files = {source: document(body, kind), **(extras or {})}
    return {"schemaVersion": 1, "sourcePath": source, "files": [
        {"path": name, "mode": "100644", "sha256": hashlib.sha256(text.encode()).hexdigest(), "content": text}
        for name, text in files.items()
    ]}


class HistoryRendererPilots(unittest.TestCase):
    def history(self, value):
        spec = importlib.util.find_spec("history_render")
        self.assertIsNotNone(spec, "the bounded current-renderer adapter is required")
        import history_render
        return history_render.render_history(value)

    def test_read_only_profile_removes_all_active_controls(self):
        self.assertIn("read_only", inspect.signature(render.render_node).parameters)
        body = ''':::run
:::
:::exercise{id="sample"}
Print a value.
```python
print(1)
```
```output
1
```
```answer
print(1)
```
:::
'''
        node = {"id": "example", "title": "Historical title", "kind": "challenge", "body": body, "dir": None}
        result = render.render_node(node, "web", read_only=True)
        self.assertNotRegex(result, r"<(?:button|textarea|input|form)\b")
        self.assertNotIn("data-challenge-view-toggle", result)
        self.assertIn("print(1)", result)

    def test_figure_uses_only_supplied_historical_bytes(self):
        self.assertIn("source", inspect.signature(render.render_node).parameters)
        value = payload(':::figure{id="fixture-only"}\n:::\n', {
            "books/figures/fixture-only.json": json.dumps({"type": "cells", "title": "Then", "caption": "Old caption", "values": [1, 2]}),
        })
        result = self.history(value)
        self.assertIn("Old caption", result["html"])
        self.assertEqual({row["path"] for row in result["reads"]}, {SOURCE, "books/figures/fixture-only.json"})

    def test_legacy_problem_and_starter_are_data_not_current_paths(self):
        value = payload(':::problem{id="included"}\n:::\n:::run{starter="starter.py"}\n:::\n', {
            "challenges/included/challenge.md": document(':::statement\nAn older problem.\n:::\n', "challenge", "included"),
            "challenges/example/starter.py": "raise RuntimeError('must remain displayed text')\n",
        }, source="challenges/example/challenge.md", kind="challenge")
        result = self.history(value)
        self.assertIn("An older problem.", result["html"])
        self.assertIn("must remain displayed text", result["html"])
        self.assertEqual(len(result["reads"]), 3)

    def test_missing_required_dependencies_refuse_without_head_fallback(self):
        self.assertIn("source", inspect.signature(render.render_node).parameters)
        for body in [':::figure{id="missing"}\n:::\n', ':::problem{id="missing"}\n:::\n', ':::run{starter="explicit.py"}\n:::\n']:
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.history(payload(body, source="books/challenges/example/challenge.md", kind="challenge"))

    def test_duplicate_snapshot_members_and_untrusted_types_refuse(self):
        value = payload("A historical paragraph.")
        self.assertTrue((TOOLS / "history_render.py").is_file(), "bounded adapter must validate input before rendering")
        for change in ("duplicate", "type", "digest", "path"):
            changed = json.loads(json.dumps(value))
            if change == "duplicate": changed["files"].append(changed["files"][0])
            if change == "type": changed["files"][0]["mode"] = "120000"
            if change == "digest": changed["files"][0]["sha256"] = "0" * 64
            if change == "path": changed["files"][0]["path"] = "../outside.md"
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.history(changed)


class HistoricalProfile(unittest.TestCase):
    def setUp(self):
        import history_render
        self.history = history_render

    def test_optional_starter_absence_is_explicit_and_explicit_starter_is_required(self):
        value = payload(':::run\n:::\n', source="books/challenges/example/challenge.md", kind="challenge")
        result = self.history.render_history(value)
        self.assertEqual(result["optionalAbsences"], ["books/challenges/example/starter.py"])
        self.assertEqual(len(result["reads"]), 1)
        present = payload(':::run\n:::\n', {"books/challenges/example/starter.py": "print('old')\n"}, source=value["sourcePath"], kind="challenge")
        self.assertEqual(self.history.render_history(present)["optionalAbsences"], [])
        with self.assertRaisesRegex(ValueError, "absent"):
            self.history.render_history(payload(':::run{starter="starter.py"}\n:::\n', source=value["sourcePath"], kind="challenge"))

    def test_starter_path_and_mode_rule_covers_explicit_and_implicit(self):
        for name in ("../x.py", "/tmp/x.py", "nested/../x.py", "nested//x.py", r"nested\x.py"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.history.render_history(payload(f':::run{{starter="{name}"}}\n:::\n', source="books/challenges/example/challenge.md", kind="challenge"))
        for directive in (':::run\n:::\n', ':::run{starter="starter.py"}\n:::\n'):
            for mode in ("120000", "160000", "040000"):
                value = payload(directive, {"books/challenges/example/starter.py": "old"}, source="books/challenges/example/challenge.md", kind="challenge")
                value["files"][1]["mode"] = mode
                with self.subTest(directive=directive, mode=mode), self.assertRaises(ValueError):
                    self.history.render_history(value)

    def test_no_dependency_can_read_current_files(self):
        from unittest.mock import patch
        value = payload(':::figure{id="old"}\n:::\n:::problem{id="old"}\n:::\n:::run\n:::\n', {
            "books/figures/old.json": json.dumps({"type": "cells", "cells": [{"label": "Old", "note": "value"}]}),
            "books/chapters/old.md": document(':::statement\nOld statement\n:::\n', identifier="old"),
            "books/challenges/example/starter.py": "print('old')",
            "books/tools/render.py": "raise RuntimeError('historical code cannot be imported')",
        }, source="books/challenges/example/challenge.md", kind="challenge")
        with patch.object(Path, "read_text", side_effect=AssertionError("unexpected current file read")), patch.object(Path, "is_file", side_effect=AssertionError("unexpected current file lookup")):
            result = self.history.render_history(value)
        self.assertEqual(len(result["reads"]), 4)
        self.assertNotIn("historical code", result["html"])

    def test_missing_dependency_does_not_cross_layouts(self):
        for source, other in ((SOURCE, "challenges/figures/old.json"), ("challenges/example.md", "books/figures/old.json")):
            with self.subTest(source=source), self.assertRaises(ValueError):
                self.history.render_history(payload(':::figure{id="old"}\n:::\n', {other: '{"type":"cells"}'}, source=source))

    def test_reference_ambiguity_and_id_mismatch_are_visible(self):
        extras = {"books/chapters/old.md": document("Old", identifier="different")}
        with self.assertRaisesRegex(ValueError, "identity"):
            self.history.render_history(payload(':::problem{id="old"}\n:::\n', extras))
        extras["books/challenges/old/challenge.md"] = document("Old", identifier="old")
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            self.history.render_history(payload(':::problem{id="old"}\n:::\n', extras))

    def test_dependency_only_change_changes_affected_block_digest(self):
        first = payload(':::figure{id="old"}\n:::\n', {"books/figures/old.json": '{"type":"cells","caption":"Before"}'})
        second = payload(':::figure{id="old"}\n:::\n', {"books/figures/old.json": '{"type":"cells","caption":"After"}'})
        before, after = [self.history.render_history(value) for value in (first, second)]
        self.assertEqual(before["sourceSha256"], after["sourceSha256"])
        self.assertEqual(before["blocks"][0], after["blocks"][0])
        self.assertEqual(before["blocks"][1]["id"], after["blocks"][1]["id"])
        self.assertNotEqual(before["blocks"][1]["digest"], after["blocks"][1]["digest"])

    def test_snapshot_order_is_irrelevant_and_input_is_not_mutated(self):
        value = payload("Old π paragraph.", {"unselected.txt": "unused"})
        original = json.loads(json.dumps(value))
        first = self.history.render_history(value)
        self.assertEqual(original, value)
        value["files"].reverse()
        self.assertEqual(first, self.history.render_history(value))
        self.assertEqual(first["reads"], [{key: original["files"][0][key] for key in ("path", "mode", "sha256")}])

    def test_newline_decoding_matches_canonical_file_reader_but_binds_raw_digest(self):
        value = payload("An old paragraph.\n")
        normal = self.history.render_history(value)
        value["files"][0]["content"] = value["files"][0]["content"].replace("\n", "\r\n")
        value["files"][0]["sha256"] = hashlib.sha256(value["files"][0]["content"].encode()).hexdigest()
        windows = self.history.render_history(value)
        self.assertEqual(normal["html"], windows["html"])
        self.assertNotEqual(normal["sourceSha256"], windows["sourceSha256"])

    def test_authored_structure_remains_canonical_without_book_navigation(self):
        value = payload('## A heading\n\n**Bold** and *emphasis*.\n\n| One | Two |\n| --- | --- |\n| old | new |\n\n```python\nprint(1)\n```\n')
        row = value["files"][0]
        row["content"] = row["content"].replace('kind = "concept"', 'kind = "concept"\nnumber = "9"\npart = "HEAD-only"\npart_number = "1"')
        row["sha256"] = hashlib.sha256(row["content"].encode()).hexdigest()
        result = self.history.render_history(value)
        for tag in ("<h2", "<strong>", "<em>", "<table>", "<pre><code"):
            self.assertIn(tag, result["html"])
        self.assertNotIn("HEAD-only", result["html"])
        self.assertNotIn('class="eyebrow"', result["html"])

    def test_closed_directives_and_modern_shapes_refuse_incompatible_data(self):
        bodies = (':::include\nold\n:::\n', ':::figure{id="old"}\n', ':::exercise{id="old"}\nmissing parts\n:::\n', ':::problem{id="../x"}\n:::\n')
        for body in bodies:
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.history.render_history(payload(body))
        for source in ("other/example.md", "books/chapters/../example.md", "books//chapters/example.md", "/books/chapters/example.md"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                self.history.render_history(payload("Old", source=source))

    def test_all_canonical_figure_types_are_static(self):
        figures = [
            {"type": "cells", "cells": [{"label": "x", "note": "y"}]},
            {"type": "walk", "sequence": [1, 2], "state": [{"label": "sum", "values": [1, 3]}]},
            {"type": "table", "header": ["a"], "rows": [[1]]},
            {"type": "cost", "x": {"values": [1, 2]}, "series": [{"label": "a", "values": [1, 2]}]},
            {"type": "links", "nodes": [{"id": "a"}, {"id": "b"}], "edges": [{"from": "a", "to": "b"}]},
        ]
        for data in figures:
            with self.subTest(kind=data["type"]):
                result = self.history.render_history(payload(':::figure{id="old"}\n:::\n', {"books/figures/old.json": json.dumps(data)}))
                self.assertNotRegex(result["html"], r"<(?:button|input|textarea|script|form)\b")
                self.assertNotIn('class="missing"', result["html"])
                self.assertIn('<figure ', result["html"])

    def test_figure_malformed_json_type_depth_and_nonfinite_refuse(self):
        deep = {"type": "cells", "extra": [[[[[[[[[[1]]]]]]]]]]}
        for raw in ('{"type":"unknown"}', '{"type":"cells","type":"table"}', '{"type":"cells","x":1e400}', '{"type":"cells","x":NaN}', json.dumps(deep), '{"type":"cells","cells":[null]}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                self.history.render_history(payload(':::figure{id="old"}\n:::\n', {"books/figures/old.json": raw}))

    def test_byte_count_file_count_and_output_bounds_refuse(self):
        from unittest.mock import patch
        for name, bound in (("MAX_BLOB_BYTES", 8), ("MAX_MAP_BYTES", 8), ("MAX_FILES", 0), ("MAX_OUTPUT_BYTES", 8)):
            with self.subTest(name=name), patch.object(self.history, name, bound), self.assertRaises(ValueError):
                self.history.render_history(payload("π" * 5))
        with self.assertRaises(ValueError):
            self.history._text("π" * 5, 8)

    def test_json_decoder_rejects_duplicate_escaped_keys_utf8_and_surrogates(self):
        for raw in (b'{"a":1,"\\u0061":2}', b'\xff', b'{"x":NaN}', b'[' * 2000):
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                self.history._json(raw)
        value = payload("Old")
        value["files"][0]["content"] = "\ud800"
        with self.assertRaises(ValueError):
            self.history.render_history(value)

    def test_read_only_requires_exact_bool_and_source_cannot_enable_runtime(self):
        node = {"id": "example", "title": "Old", "kind": "concept", "body": "Old"}
        for value in (1, "false", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                render.render_node(node, "web", read_only=value)
        with self.assertRaises(ValueError):
            render.render_node(node, "web", source=object())

    def test_default_missing_starter_remains_permissive(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            for directive in (':::run\n:::\n', ':::run{starter="missing.py"}\n:::\n'):
                node = {"id": "example", "title": "Old", "kind": "challenge", "body": directive, "dir": Path(folder)}
                result = render.render_node(node, "web", runnable=False)
                self.assertIn('<pre><code></code></pre>', result)

    def test_emission_budget_stops_before_next_dependency(self):
        self.assertIn("max_output_bytes", inspect.signature(render.render_node).parameters)
        class Source:
            calls = 0
            def figure_data(inner_self, identifier):
                inner_self.calls += 1
                return {"type": "cells", "caption": "x" * 1000}
        source = Source()
        node = {"id": "example", "title": "Old", "kind": "concept", "body": ':::figure{id="old"}\n:::\n' * 100}
        with self.assertRaisesRegex(ValueError, "output"):
            render.render_node(node, "web", source=source, read_only=True, max_output_bytes=2000)
        self.assertLess(source.calls, 3)

    def test_walk_repeated_labels_are_bounded_before_canonical_drawing(self):
        from unittest.mock import patch
        value = payload(':::figure{id="old"}\n:::\n', {"books/figures/old.json": json.dumps({"type": "walk", "sequence": list(range(100)), "state": [{"label": "x" * 1000, "values": [1] * 100}]})})
        with patch.object(self.history, "MAX_OUTPUT_BYTES", 10_000), patch.object(render, "_figure_body", side_effect=AssertionError("oversized drawing must not start")), self.assertRaisesRegex(ValueError, "bound"):
            self.history.render_history(value)

    def test_figure_work_is_cumulative_across_occurrences(self):
        from unittest.mock import patch
        one = payload(':::figure{id="old"}\n:::\n', {"books/figures/old.json": '{"type":"cells"}'})
        repeated = payload(':::figure{id="old"}\n:::\n' * 4, {"books/figures/old.json": '{"type":"cells"}'})
        with patch.object(self.history, "MAX_FIGURE_WORK", 6):
            self.history.render_history(one)
            with self.assertRaisesRegex(ValueError, "work bound"):
                self.history.render_history(repeated)

    def test_isolated_cli_import_and_error_output_do_not_expose_source(self):
        import os
        import subprocess
        import tempfile
        env = {name: value for name, value in os.environ.items() if not name.startswith(("PYTHON", "GIT_"))}
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        with tempfile.TemporaryDirectory() as folder:
            # The current fixed module wins even when caller cwd supplies code.
            Path(folder, "render.py").write_text("raise RuntimeError('wrong module')")
            command = [sys.executable, "-I", "-B", str(TOOLS / "history_render.py")]
            good = subprocess.run(command, input=json.dumps(payload("Old π")).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=folder, env=env, timeout=5)
            self.assertEqual(good.returncode, 0, good.stderr)
            self.assertIn("Old π", json.loads(good.stdout)["html"])
            self.assertEqual(good.stderr, b"")
            bad = subprocess.run(command, input=b'{"private-source-marker": "secret fixture"}', stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=folder, env=env, timeout=5)
            self.assertEqual(bad.returncode, 2)
            self.assertEqual(bad.stdout, b"")
            self.assertNotIn(b"private-source-marker", bad.stderr)
            self.assertNotIn(b"secret fixture", bad.stderr)
            self.assertNotIn(b"Traceback", bad.stderr)

    def test_ambiguous_directive_attributes_cannot_select_different_bytes(self):
        for attrs in ('starter="first.py" starter="last.py"', 'starter="first.py second.py"', 'starter="first.py', 'junk starter="first.py"'):
            value = payload(f':::run{{{attrs}}}\n:::\n', {"books/challenges/example/first.py": "first", "books/challenges/example/last.py": "last"}, source="books/challenges/example/challenge.md", kind="challenge")
            with self.subTest(attrs=attrs), self.assertRaises(ValueError):
                self.history.render_history(value)

    def test_optional_and_explicit_empty_starter_are_not_confused(self):
        value = payload(':::run{starter=""}\n:::\n', source="books/challenges/example/challenge.md", kind="challenge")
        with self.assertRaises(ValueError):
            self.history.render_history(value)

    def test_frontmatter_failure_and_current_exercise_controls_remain_unchanged(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder, "missing.md")
            path.write_text("no front matter")
            with self.assertRaises(ValueError) as raised:
                render.read_front_matter(path)
            self.assertEqual(str(raised.exception), f"{path} has no +++ front matter")
        inner = 'Try.\n```python\nprint(0)\n```\n```output\n1\n```\n```answer\nprint(1)\n```\n'
        ordinary = render.exercise("old", inner, "web")
        self.assertIn("<textarea", ordinary)
        self.assertIn("<button", ordinary)
        readonly = render.exercise("old", inner, "web", read_only=True)
        self.assertNotRegex(readonly, r"<(?:textarea|button)\b")
        self.assertIn("<details", readonly)

    def test_budget_validation_never_enables_non_readonly_mode(self):
        node = {"id": "example", "title": "Old", "kind": "concept", "body": "Old"}
        for maximum in (0, -1, True, "100", 1.5):
            with self.subTest(maximum=maximum), self.assertRaises(ValueError):
                render.render_node(node, read_only=True, max_output_bytes=maximum)
        with self.assertRaises(ValueError):
            render.render_node(node, max_output_bytes=100)
        self.assertEqual(render.render_node(node), render.render_node(node, max_output_bytes=None))

    def test_cli_input_limit_prevents_rendering_and_emits_no_partial_result(self):
        import io
        from unittest.mock import patch
        class Stream:
            def __init__(self, data=b""):
                self.buffer = io.BytesIO(data)
        stdin, stdout, stderr = Stream(b"x" * 10), Stream(), io.StringIO()
        with patch.object(self.history, "MAX_INPUT_BYTES", 5), patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr), patch.object(self.history, "render_history", side_effect=AssertionError("oversized input must not render")):
            self.assertEqual(self.history.main(), 2)
        self.assertEqual(stdout.buffer.getvalue(), b"")
        self.assertNotIn("xxxxx", stderr.getvalue())
