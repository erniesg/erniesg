"""Reference solution for Chapter 2."""


def max_pairwise_product_naive(numbers: list[int]) -> int:
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
    if len(numbers) < 2:
        raise ValueError("need at least two numbers")
    # One pass tracking the two largest and two smallest values: with
    # negatives allowed, the winner is either top1*top2 or bottom1*bottom2.
    top1 = top2 = None
    bot1 = bot2 = None
    for value in numbers:
        if top1 is None or value > top1:
            top1, top2 = value, top1
        elif top2 is None or value > top2:
            top2 = value
        if bot1 is None or value < bot1:
            bot1, bot2 = value, bot1
        elif bot2 is None or value < bot2:
            bot2 = value
    return max(top1 * top2, bot1 * bot2)
