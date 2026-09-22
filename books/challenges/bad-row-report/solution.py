"""Reference solution: report the mess, raise only on a broken call."""


def parse_amounts(lines: list[str]) -> tuple[int, list[tuple[int, str]]]:
    if not isinstance(lines, list):
        raise TypeError(f"lines must be a list of strings, got {lines!r}")

    total = 0
    problems: list[tuple[int, str]] = []
    for number, line in enumerate(lines, start=1):
        text = line.strip()
        if not text:
            continue
        try:
            amount = int(text)
        except ValueError:
            problems.append((number, line))
            continue
        if amount < 0:
            problems.append((number, line))
            continue
        total += amount
    return (total, problems)
