"""Reference solution: halve the timetable, then guard the end of the list."""


def next_departure(departures: list[int], arrival: int) -> int:
    low, high = 0, len(departures) - 1
    while low <= high:
        mid = (low + high) // 2
        if departures[mid] < arrival:
            low = mid + 1
        else:
            high = mid - 1
    if low == len(departures):
        return -1
    return departures[low]
