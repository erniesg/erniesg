"""Reference solution: None as the default, one pass, append in place."""


def log_shortfalls(
    served: list[int], target: int = 180, log: list[tuple[int, int]] | None = None
) -> list[tuple[int, int]]:
    if log is None:
        log = []
    for night, meals in enumerate(served):
        if meals < target:
            log.append((night, target - meals))
    return log
