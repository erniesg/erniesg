"""Nights that fell short.

    python3 books/tools/grade.py run shortfall-log
"""


def log_shortfalls(
    served: list[int], target: int = 180, log: list[tuple[int, int]] | None = None
) -> list[tuple[int, int]]:
    # A list is the one thing that must never be a default. Start from None
    # and build the empty log inside, then walk `served` once keeping the
    # position as well as the value.
    raise NotImplementedError("Write me")
