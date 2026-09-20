"""Reference solution: one pass, keeping the best two values."""


def max_pairwise_product(numbers: list[int]) -> int:
    first = second = -1
    for value in numbers:
        if value > first:
            first, second = value, first
        elif value > second:
            second = value
    return first * second
