"""Reference solution: count frozen baskets in one pass."""


def most_common_basket(baskets: list[list[str]]) -> list[str]:
    counts: dict[tuple[str, ...], int] = {}
    for basket in baskets:
        frozen = tuple(basket)
        counts[frozen] = counts.get(frozen, 0) + 1
    if not counts:
        return []
    return list(max(counts, key=counts.get))
