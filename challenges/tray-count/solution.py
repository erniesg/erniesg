"""Reference solution: round up with floor division, then derive the spare."""


def trays_needed(portions: int, per_tray: int = 12) -> tuple[int, int]:
    trays = (portions + per_tray - 1) // per_tray
    return (trays, trays * per_tray - portions)
