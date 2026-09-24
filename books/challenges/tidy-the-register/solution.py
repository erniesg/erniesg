"""Reference solution: one comprehension, which cannot touch the input."""


def tidy_names(names: list[str]) -> list[str]:
    return [name.strip() for name in names if name.strip()]
