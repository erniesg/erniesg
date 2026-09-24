"""Reference solution: lowercase, split on runs of space, join with hyphens."""


def title_to_slug(title: str) -> str:
    return "-".join(title.lower().split())
