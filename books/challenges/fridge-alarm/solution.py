"""Reference solution: one ladder, in the order the statement fixes."""


def fridge_message(celsius, door_open_minutes: int, power_ok: bool) -> str:
    if celsius is None:
        return "check the sensor"
    elif not power_ok:
        return "power lost"
    elif celsius > 8:
        return "too warm"
    elif celsius < 2:
        return "too cold"
    elif door_open_minutes >= 10:
        return "close the door"
    else:
        return "ok"
