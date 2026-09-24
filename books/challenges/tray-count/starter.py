"""How many trays to order.

    python3 books/tools/grade.py run tray-count
"""


def trays_needed(portions: int, per_tray: int = 12) -> tuple[int, int]:
    # Round the tray count UP: a part-full tray is still a whole tray.
    # Then the spare is what those trays bring minus what leaves.
    raise NotImplementedError("Write me")
