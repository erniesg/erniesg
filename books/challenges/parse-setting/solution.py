"""Reference solution: strip, rule out, cut once, strip again."""


def parse_setting(line: str) -> tuple[str, str] | None:
    text = line.strip()
    if not text or text.startswith("#"):
        return None
    if "=" not in text:
        return None
    key, value = text.split("=", 1)
    key = key.strip().lower()
    if not key:
        return None
    return (key, value.strip())
