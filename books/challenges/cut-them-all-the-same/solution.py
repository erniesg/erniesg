"""Reference solution: halve the range of lead lengths, not the pile."""


def longest_lead(pieces: list[int], wanted: int) -> int:
    if not pieces:
        return 0

    def leads_at(length: int) -> int:
        return sum(piece // length for piece in pieces)

    low, high, best = 1, max(pieces), 0
    while low <= high:
        mid = (low + high) // 2
        if leads_at(mid) >= wanted:
            best = mid
            low = mid + 1
        else:
            high = mid - 1
    return best
