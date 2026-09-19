"""Chapter 2 — Tests as executable definitions.

Implement `max_pairwise_product`. Keep `max_pairwise_product_naive` as-is:
it is your slow-but-obviously-correct referee, and the stress tier uses the
same double-loop idea to check you.

    python3 books/dsa/tools/runner.py run ch02
"""


def max_pairwise_product_naive(numbers: list[int]) -> int:
    """O(n^2) referee: try every pair. Correct, slow, trustworthy."""
    best = None
    for i in range(len(numbers)):
        for j in range(i + 1, len(numbers)):
            product = numbers[i] * numbers[j]
            if best is None or product > best:
                best = product
    if best is None:
        raise ValueError("need at least two numbers")
    return best


def max_pairwise_product(numbers: list[int]) -> int:
    """Return the maximum product of two different elements.

    Constraints: 2 <= len(numbers) <= 3 * 10**5,
                 -2 * 10**5 <= numbers[k] <= 2 * 10**5.
    Must be O(n) or O(n log n) — the perf tier enforces this.
    Careful: values may be negative.
    """
    # TODO: replace this with your fast implementation.
    raise NotImplementedError
