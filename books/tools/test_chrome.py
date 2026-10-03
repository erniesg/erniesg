"""chrome.py: the plain reader's rail, front bar and map, for every surface.

    python3 -m unittest discover -s books/tools -p 'test_*.py'
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import chrome
from render import load_book, render_node


def site_href(node_id: str) -> str:
    return f"/books/b/{node_id}/"


class ChapterRail(unittest.TestCase):
    def setUp(self):
        _, self.order = load_book()
        self.chapter = next(n for n in self.order if n["id"] == "ch03-lists")
        self.markup = render_node(self.chapter, "web")

    def test_lists_the_sections_and_the_connections_with_this_surfaces_links(self):
        rail = chrome.chapter_rail(self.markup, self.chapter, self.order, site_href, "/books/b/map/")
        self.assertIn("In this chapter", rail)
        self.assertIn("Connected", rail)
        self.assertIn('href="/books/b/map/"', rail)
        for target in self.chapter.get("requires", []):
            self.assertIn(f'href="/books/b/{target}/"', rail)
        self.assertIn('data-rail-section="', rail)

    def test_leaves_out_connections_outside_the_pool(self):
        rail = chrome.chapter_rail(self.markup, self.chapter, [self.chapter], site_href, "/m")
        self.assertNotIn("Connected", rail)
        self.assertIn("In this chapter", rail)

    def test_draws_nothing_when_there_is_nothing_to_say(self):
        self.assertEqual(chrome.chapter_rail("<p>x</p>", None, self.order, site_href, "/m"), "")


class FrontNavigation(unittest.TestCase):
    def test_says_contents_how_much_is_solved_and_points_at_the_first_page(self):
        _, order = load_book()
        challenges = [n["id"] for n in order if n.get("kind") == "challenge"]
        bar = chrome.front_navigation(order, site_href, frozenset(challenges[:2]))
        self.assertIn('data-kind="front"', bar)
        self.assertIn(">Contents<", bar)
        self.assertIn(f">2/{len(challenges)} solved<", bar)
        self.assertIn(f'rel="next" href="/books/b/{order[0]["id"]}/"', bar)
        self.assertIn("data-chapter-progress", bar)


class PrintMarkup(unittest.TestCase):
    def test_every_node_in_reading_order_with_the_previews_anchors(self):
        order = [{"id": "a"}, {"id": "b"}]
        markup = chrome.print_markup(order, lambda node: f"<p>{node['id']}</p>")
        self.assertEqual(
            markup,
            "<article class='print-page' id='print-a'><p>a</p></article>"
            "<article class='print-page' id='print-b'><p>b</p></article>",
        )


if __name__ == "__main__":
    unittest.main()
