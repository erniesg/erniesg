"""Reference solution: two sets for the questions, a list for the order."""


def missing_items(requested: list[str], stocked: list[str]) -> list[str]:
    in_bin = set(stocked)
    listed: set[str] = set()
    answer: list[str] = []
    for name in requested:
        if name not in in_bin and name not in listed:
            listed.add(name)
            answer.append(name)
    return answer
