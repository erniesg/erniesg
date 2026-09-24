"""One line of a settings file.

    python3 books/tools/grade.py run parse-setting
"""


def parse_setting(line: str) -> tuple[str, str] | None:
    # Strip the line first; every rule is about what is left.
    # Rule out the lines that hold no setting, then cut at the first `=`.
    raise NotImplementedError("Write me")
