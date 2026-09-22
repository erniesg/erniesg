"""Reference solution: one pass, remembering the cheapest reading so far."""


def best_gain(prices: list[int]) -> int:
    best = 0
    cheapest_so_far = None
    for price in prices:
        if cheapest_so_far is None:
            cheapest_so_far = price
            continue
        if price - cheapest_so_far > best:
            best = price - cheapest_so_far
        if price < cheapest_so_far:
            cheapest_so_far = price
    return best
