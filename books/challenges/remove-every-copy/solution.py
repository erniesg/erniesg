"""Reference solution: one pass, building a new list rather than editing one."""


def without(items: list[str], unwanted: str) -> list[str]:
    kept = []
    for item in items:
        if item != unwanted:
            kept.append(item)
    return kept
