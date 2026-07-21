"""Reference solution for Chapter 3."""


def first_duplicate(paths: list[str]) -> str | None:
    seen: set[str] = set()
    for path in paths:
        if path in seen:
            return path
        seen.add(path)
    return None
