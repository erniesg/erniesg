"""render.py: reading order, the pager, and the chapter progress indicator.

    python3 -m unittest discover -s books/tools -p 'test_*.py'
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from render import (  # noqa: E402
    chapter_of,
    load_book,
    page_navigation,
    reading_navigation,
    render_node,
    section_headings,
)


def href(node_id: str) -> str:
    return f"/{node_id}"


class ReadingNavigation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _, cls.order = load_book()
        cls.ids = [node["id"] for node in cls.order]
        cls.rendered: dict[str, str] = {}

    def sections(self, node_id: str) -> list[tuple[str, str]]:
        if node_id not in self.rendered:
            node = next(n for n in self.order if n["id"] == node_id)
            self.rendered[node_id] = render_node(node)
        return section_headings(self.rendered[node_id])

    def nav(self, node_id: str, solved=frozenset()) -> dict[str, str]:
        return reading_navigation(self.order, node_id, href, self.sections, solved)

    def test_a_practice_challenge_belongs_to_the_chapter_it_follows(self):
        chapter = chapter_of(self.order, "pool-ticket-price")
        self.assertEqual("ch02-conditionals", chapter["id"])
        self.assertEqual(["pool-ticket-price", "fridge-alarm"], chapter["practice"])
        self.assertEqual("ch02-conditionals", chapter_of(self.order, "ch02-conditionals")["id"])
        self.assertIsNone(chapter_of(self.order, "front-matter"))

    def test_the_pager_follows_reading_order_and_names_both_ends(self):
        index = self.ids.index("pool-ticket-price")
        pager = self.nav("pool-ticket-price")["pager"]
        self.assertIn(f'rel="prev" href="/{self.ids[index - 1]}"', pager)
        self.assertIn(f'rel="next" href="/{self.ids[index + 1]}"', pager)
        self.assertIn("Choosing with if", pager)
        self.assertIn("The fridge that holds the medicine", pager)

    def test_the_first_and_last_nodes_have_one_side_each(self):
        first = self.nav(self.ids[0])["pager"]
        self.assertNotIn('rel="prev"', first)
        self.assertIn('rel="next"', first)
        last = self.nav(self.ids[-1])["pager"]
        self.assertIn('rel="prev"', last)
        self.assertNotIn('rel="next"', last)

    def test_a_chapter_page_counts_its_sections_and_its_practice(self):
        progress = self.nav("ch02-conditionals")["progress"]
        sections = self.sections("ch02-conditionals")
        self.assertGreater(len(sections), 2)
        self.assertEqual(len(sections), progress.count("data-cp-section="))
        self.assertEqual(2, progress.count("data-cp-practice="))
        self.assertIn("Ch 2 · Choosing with if", progress)
        self.assertIn(f"Section 1 of {len(sections)} · practice 0/2 solved", progress)
        # Sections on the chapter's own page are same-page anchors.
        self.assertIn(f'href="#{sections[0][0]}"', progress)

    def test_a_challenge_page_marks_itself_current_and_links_the_chapter_sections(self):
        progress = self.nav("fridge-alarm", solved=frozenset({"pool-ticket-price"}))["progress"]
        self.assertIn("Practice 2 of 2 · 1/2 solved", progress)
        current = re.search(r'<a [^>]*aria-current="page"[^>]*>', progress)
        self.assertIsNotNone(current)
        self.assertIn('data-cp-practice="fridge-alarm"', current.group(0))
        solved = re.search(r'<a [^>]*data-cp-practice="pool-ticket-price"[^>]*>', progress)
        self.assertIn("data-progress-done", solved.group(0))
        anchor = self.sections("ch02-conditionals")[0][0]
        self.assertIn(f'href="/ch02-conditionals#{anchor}"', progress)

    def test_every_practice_segment_is_wired_to_the_progress_runtime(self):
        progress = self.nav("ch02-conditionals")["progress"]
        for node_id in ("pool-ticket-price", "fridge-alarm"):
            self.assertIn(
                f'data-cp-practice="{node_id}" data-progress-items="{node_id}"', progress
            )

    def test_front_matter_has_steps_but_no_chapter_track(self):
        progress = self.nav("front-matter")["progress"]
        self.assertIn('data-kind="none"', progress)
        self.assertNotIn("cp-track", progress)
        self.assertIn('rel="next"', progress)

    def test_the_indicator_offers_the_shortcut_help(self):
        progress = self.nav("ch07-strings")["progress"]
        self.assertIn("data-book-keys-toggle", progress)
        self.assertIn('aria-keyshortcuts="?"', progress)


class BookPageNavigation(unittest.TestCase):
    """The front page and the map get the same bar as a chapter (`page_navigation`)."""

    @classmethod
    def setUpClass(cls):
        _, cls.order = load_book()

    def test_the_front_page_leads_into_the_first_page(self):
        bar = page_navigation(self.order, href, title="Contents")
        self.assertIn('data-chapter-progress data-kind="book"', bar)
        self.assertIn(">Contents<", bar)
        self.assertIn(f'rel="next" href="/{self.order[0]["id"]}"', bar)
        self.assertNotIn('rel="prev"', bar)
        self.assertIn("data-book-keys-toggle", bar)

    def test_the_map_steps_back_to_the_front_page_and_on_to_the_first_page(self):
        bar = page_navigation(self.order, href, title="The map", previous=("Contents", "/"))
        self.assertIn(">The map<", bar)
        self.assertIn('rel="prev" href="/"', bar)
        self.assertIn('aria-label="Previous: Contents"', bar)
        self.assertIn(f'rel="next" href="/{self.order[0]["id"]}"', bar)

    def test_its_parts_are_the_chapter_bar_parts(self):
        """Same classes, so one stylesheet and one runtime drive every page's bar."""
        bar = page_navigation(self.order, href, title="Contents")
        for part in ('class="chapter-progress"', 'class="cp-step"', 'class="cp-body"', 'class="cp-keys"'):
            self.assertIn(part, bar)


if __name__ == "__main__":
    unittest.main()
