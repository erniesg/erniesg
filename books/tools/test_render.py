"""render.py: support notes per target, and the pre-rename workspace.

    python3 -m unittest discover -s books/tools -p 'test_*.py'
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import render


class PrintSupportNotes(unittest.TestCase):
    """Rule (spec 066): print keeps a support note for every support level.

    The web drops the `worked` and `guided` notes because the hint bulb and the
    solution disclosure carry that; a printed page has neither.
    """

    def test_every_level_prints_a_note(self):
        _, order = render.load_book()
        seen: set[str] = set()
        for node in order:
            if node.get("kind") != "challenge":
                continue
            support = node.get("support", "guided")
            seen.add(support)
            printed = render.render_node(node, "print")
            with self.subTest(node["id"]):
                self.assertIn(f'class="support support-{support}"', printed)
        self.assertEqual(seen, set(render.SUPPORT_LEVELS))

    def test_every_level_has_non_empty_print_wording(self):
        for level in render.SUPPORT_LEVELS:
            self.assertTrue(render.SUPPORT_NOTES_PRINT.get(level, "").strip(), level)

    def test_unaided_reminder_is_short_in_every_output(self):
        _, order = render.load_book()
        for node in order:
            if node.get("support") != "unaided":
                continue
            for target, reveal in (("web", "reader"), ("web", "grader"), ("print", "reader")):
                with self.subTest(node=node["id"], target=target, reveal=reveal):
                    markup = render.render_node(node, target, reveal=reveal)
                    self.assertIn("Try it before viewing the solution.", markup)
                    self.assertNotIn("No hints on this one", markup)
                    self.assertNotIn("tells you whether it stuck", markup)

    def test_debugger_has_a_print_fallback_and_condensed_web_examples(self):
        node = render.load_node("ch09-stepping")
        web = render.render_node(node, "web", reveal="reader")
        printed = render.render_node(node, "print")
        self.assertIn("data-pdb-demo", web)
        self.assertIn('data-margin-annotatable="false"', web)
        self.assertIn('data-pdb-command-form', web)
        self.assertIn('<details class="book-example">', web)
        self.assertNotIn("data-pdb-demo", printed)
        self.assertNotIn("data-pdb-command-form", printed)
        self.assertIn("(Pdb) p day", printed)
        self.assertIn("22985", printed)

    def test_reader_shortens_contract_support_but_print_keeps_it(self):
        _, order = render.load_book()
        contract = next(node for node in order if node["id"] == "meter-days")

        reader = render.render_node(contract, "web", runnable=False, reveal="reader")
        printed = render.render_node(contract, "print")

        self.assertIn('class="support support-contract"', reader)
        self.assertIn("The worked solution is below.", reader)
        self.assertNotIn("You get the contract and the tests.", reader)
        self.assertIn("<details class='hint'>", reader)
        self.assertIn("<details class='solution'>", reader)
        self.assertIn('class="support support-contract"', printed)
        self.assertIn("You get the contract and the tests.", printed)
        ids = lambda markup: re.findall(r' id="(block-meter-days-[^"]+)"', markup)
        self.assertEqual(ids(reader), [
            "block-meter-days-eyebrow-1",
            "block-meter-days-title-1",
            "block-meter-days-support-1",
            "block-meter-days-card-1",
            "block-meter-days-figure-1",
            "block-meter-days-desk-1",
            "block-meter-days-hints-1",
            "block-meter-days-solution-1",
        ])
        previous = render.SUPPORT_NOTES_READER
        try:
            render.SUPPORT_NOTES_READER = {
                **previous,
                "contract": "You get the contract and the tests. The hints are here, and "
                            "the worked solution is below when you want it.",
            }
            verbose_reader = render.render_node(contract, "web", runnable=False, reveal="reader")
        finally:
            render.SUPPORT_NOTES_READER = previous
        blocks = lambda markup: {
            (kind, identifier): digest
            for kind, digest, identifier in re.findall(
                r'data-block-kind="(\w+)" data-block-digest="([0-9a-f]{12})" '
                r'id="([^"]+)"',
                markup,
            )
        }
        concise_blocks = blocks(reader)
        verbose_blocks = blocks(verbose_reader)
        self.assertEqual(set(concise_blocks), set(verbose_blocks))
        self.assertNotEqual(
            concise_blocks[("support", "block-meter-days-support-1")],
            verbose_blocks[("support", "block-meter-days-support-1")],
        )
        self.assertEqual(
            {key: digest for key, digest in concise_blocks.items() if key[0] != "support"},
            {key: digest for key, digest in verbose_blocks.items() if key[0] != "support"},
        )


class LegacyWorkspace(unittest.TestCase):
    """Rule: attempts saved before the rename stay visible after it."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.legacy = self.root / "challenges" / "workspace"
        self.current = self.root / "books" / "workspace"

    def write(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_everything_moves_when_the_new_workspace_is_new(self):
        self.write(self.legacy / "max-pairwise-product" / "pairwise.py", "mine")
        self.write(self.legacy / "progress.json", json.dumps({"solved": ["a"]}))
        left = render.migrate_legacy_workspace(self.legacy, self.current)
        self.assertEqual(left, [])
        self.assertEqual((self.current / "max-pairwise-product" / "pairwise.py").read_text(), "mine")
        self.assertEqual(json.loads((self.current / "progress.json").read_text())["solved"], ["a"])
        self.assertFalse(self.legacy.exists())

    def test_progress_merges_and_a_clash_is_left_not_overwritten(self):
        self.write(self.legacy / "progress.json", json.dumps({"solved": ["a", "b"]}))
        self.write(self.current / "progress.json", json.dumps({"solved": ["b", "c"]}))
        self.write(self.legacy / "x" / "m.py", "old attempt")
        self.write(self.current / "x" / "m.py", "new attempt")
        self.write(self.legacy / "y" / "m.py", "only old")
        left = render.migrate_legacy_workspace(self.legacy, self.current)
        self.assertEqual(
            sorted(json.loads((self.current / "progress.json").read_text())["solved"]),
            ["a", "b", "c"],
        )
        self.assertEqual((self.current / "x" / "m.py").read_text(), "new attempt")
        self.assertEqual((self.current / "y" / "m.py").read_text(), "only old")
        self.assertEqual(left, [self.legacy / "x"])
        self.assertEqual((self.legacy / "x" / "m.py").read_text(), "old attempt")

    def test_nothing_to_do_does_nothing(self):
        self.assertEqual(render.migrate_legacy_workspace(self.legacy, self.current), [])
        self.assertFalse(self.current.exists())

    def test_the_tools_that_read_the_workspace_migrate_first(self):
        # grade.py and preview.py are the two entry points that read attempts.
        for tool in ("grade.py", "preview.py"):
            source = (Path(__file__).parent / tool).read_text()
            main = source[source.index("def main("):]
            with self.subTest(tool):
                self.assertIn("report_legacy_workspace()", main)


if __name__ == "__main__":
    unittest.main()


class ChallengeSplit(unittest.TestCase):
    """A challenge's web markup is two panes: the question, then the work.

    Stacked, it must read exactly as before the panes existed, and every
    addressable block keeps its id: the margin anchors to those.
    """

    def challenges(self):
        _, order = render.load_book()
        return [node for node in order if node.get("kind") == "challenge"]

    def test_every_challenge_splits_at_its_desk_on_both_web_hosts(self):
        for node in self.challenges():
            for runnable, reveal in ((True, "grader"), (False, "reader")):
                markup = render.render_node(node, "web", runnable=runnable, reveal=reveal)
                with self.subTest(node=node["id"], runnable=runnable):
                    self.assertIn("data-challenge-split", markup)
                    self.assertIn("data-challenge-view-toggle", markup)
                    question, work = markup.split('split-work"', 1)
                    self.assertNotIn('data-block-kind="desk"', question)
                    self.assertIn('data-block-kind="desk"', work)
                    self.assertIn('data-block-kind="card"', question)

    def test_the_panes_keep_every_block_in_its_written_order(self):
        tag = re.compile(r'<div class="block" data-block-kind="(\w+)" data-block-digest="(\w+)" id="([^"]+)">')
        for node in self.challenges():
            markup = render.render_node(node, "web", runnable=False, reveal="reader")
            pieces = markup.split('data-challenge-split>', 1)
            with self.subTest(node=node["id"]):
                self.assertEqual(len(pieces), 2)
                blocks = tag.findall(markup)
                self.assertTrue(blocks)
                # The wrappers add no ids and drop none.
                self.assertEqual(len({identifier for *_, identifier in blocks}), len(blocks))
                kinds = [kind for kind, *_ in blocks]
                self.assertLess(kinds.index("card"), kinds.index("desk"))

    def test_print_and_chapters_are_not_split(self):
        _, order = render.load_book()
        chapter = next(node for node in order if node.get("kind") != "challenge")
        self.assertNotIn("data-challenge-split", render.render_node(chapter, "web"))
        challenge = self.challenges()[0]
        self.assertNotIn("data-challenge-split", render.render_node(challenge, "print"))

    def test_the_view_contract_is_one_key_and_one_attribute(self):
        self.assertIn(render.CHALLENGE_VIEW_KEY, render.CHALLENGE_VIEW_HEAD_SCRIPT)
        self.assertIn(render.CHALLENGE_VIEW_ATTRIBUTE, render.CHALLENGE_VIEW_HEAD_SCRIPT)
        self.assertIn(render.CHALLENGE_VIEW_KEY, render.SPLIT_SCRIPT)
        self.assertIn(f"min-width: {render.CHALLENGE_SPLIT_MIN_WIDTH}px", render.SPLIT_SCRIPT)
        self.assertIn(f"screen and (min-width:{render.CHALLENGE_SPLIT_MIN_WIDTH}px)", render.SPLIT_CSS)
        self.assertNotRegex(render.SPLIT_CSS + render.SPLIT_SCRIPT, r"%\(\w+\)s")
        site_head = (Path(__file__).resolve().parents[2] / "src/components/Head.astro").read_text()
        self.assertIn(f"localStorage.getItem('{render.CHALLENGE_VIEW_KEY}')", site_head)
        self.assertIn(f"setAttribute('{render.CHALLENGE_VIEW_ATTRIBUTE}'", site_head)
