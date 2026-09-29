"""What grading shares between the local grader and the browser's.

Stdlib only and free of the book's paths, so the published site can run it
inside Pyodide exactly as `grade.py` runs it on the reader's machine: the tier
order, which tiers record calls, and the one-line summary of a failing tier.
"""

from __future__ import annotations

import io
import re
from collections import deque
from pathlib import Path

TIERS = ["public", "edge", "stress", "perf"]

# The perf tier times the reader's function, so it never runs with calls
# recorded: capturing output per call would change what it measures.
UNRECORDED_TIERS = {"perf"}
SAMPLE_TIER = "public"  # the public tier holds exactly the rows printed in the statement

# A tier's combined output (what the reader printed outside a recorded call,
# and the runner's report) keeps this many characters at each end.
COMBINED_LIMIT_CHARS = 20_000


class BoundedText(io.TextIOBase):
    """Text kept only at both ends, bounded as it is written.

    The first and the last `limit` characters are stored; everything between
    is counted in lines and let go as it arrives. A print in a hot loop, or one
    huge write, costs at most twice `limit` however long the run goes on. The
    tail is kept because unittest reports last, and `summarize` reads it.
    """

    def __init__(self, limit: int = COMBINED_LIMIT_CHARS):
        super().__init__()
        self.limit = limit
        self._head: list[str] = []
        self._head_size = 0
        self._tail: deque[str] = deque()
        self._tail_size = 0
        self.dropped_lines = 0
        self._dropped_chars = 0
        self._tail_starts_a_line = True  # whether the last character let go was a newline

    def writable(self) -> bool:
        return True

    def write(self, text) -> int:
        # Only bounded slices are ever copied: the discarded middle of a huge
        # write is counted by index (str.count with bounds), never materialized.
        text = text if isinstance(text, str) else str(text)
        written = len(text)
        start = 0
        room = self.limit - self._head_size
        if room > 0:
            part = text[:room]
            self._head.append(part)
            self._head_size += len(part)
            start = len(part)
        rest = written - start
        if rest <= 0:
            return written
        if rest >= self.limit:
            # this write alone refills the tail: what the tail held goes, and so
            # does this write's middle
            while self._tail:
                piece = self._tail.popleft()
                self._drop(piece, 0, len(piece))
            keep_from = written - self.limit
            self._drop(text, start, keep_from)
            self._tail.append(text[keep_from:])
            self._tail_size = self.limit
            return written
        self._tail.append(text[start:])
        self._tail_size += rest
        while self._tail_size > self.limit:
            excess = self._tail_size - self.limit
            first = self._tail[0]
            if len(first) <= excess:
                self._tail.popleft()
                self._drop(first, 0, len(first))
                self._tail_size -= len(first)
            else:
                self._drop(first, 0, excess)
                self._tail[0] = first[excess:]
                self._tail_size -= excess
        return written

    def _drop(self, text: str, begin: int, end: int) -> None:
        if end <= begin:
            return
        self._dropped_chars += end - begin
        self.dropped_lines += text.count("\n", begin, end)
        self._tail_starts_a_line = text[end - 1] == "\n"

    @property
    def stored_chars(self) -> int:
        return self._head_size + self._tail_size

    def getvalue(self) -> str:
        head, tail = "".join(self._head), "".join(self._tail)
        if not self._dropped_chars:
            return head + tail
        dropped = self.dropped_lines
        cut = tail.find("\n")
        if dropped and cut != -1 and not self._tail_starts_a_line:
            tail, dropped = tail[cut + 1 :], dropped + 1  # no half line after the gap
        if dropped:
            marker = f"…truncated, {dropped} more line{'' if dropped == 1 else 's'}\n"
        else:
            # the cut fell inside one line: say how much of it went
            chars = self._dropped_chars
            marker = f"…truncated, {chars} more character{'' if chars == 1 else 's'} of a long line\n"
        return head + ("" if head.endswith("\n") else "\n") + marker + tail



def harness_frame(path: str) -> bool:
    """Whether a traceback frame belongs to the grader rather than the reader.

    Decided on path components, never on a separator-bearing substring: a
    Windows traceback says `\\tests\\`, not `/tests/`, and a reader's folder
    that merely contains the word "unittest" is still theirs.
    """
    parts = [part for part in re.split(r"[\\/]+", path) if part]
    folders, name = parts[:-1], (parts[-1] if parts else path)
    return "tests" in folders or "unittest" in folders or name == "bookgrader.py"


FRAME = re.compile(r'^\s*File "([^"]+)", line (\d+)', re.MULTILINE)
ASSERTION = re.compile(r"^AssertionError: (.*?)(?: : (.*))?$", re.MULTILINE)
EXCEPTION = re.compile(r"^(\w+(?:Error|Exception|Exit|Interrupt)|NotImplementedError)(?::\s?(.*))?$", re.MULTILINE)
DIFFER = re.compile(r"^(?:Lists|Tuples|Sets|Dicts|Sequences|Strings?) differ: ")
SOLVE_CALL = re.compile(r"self\.solve\((.*)\)\s*,")
FUNCTION = re.compile(r'load_solution\([^)]*\)\.(\w+)')


def summarize(output: str, test_file: Path | None = None) -> str:
    """The one line a reader needs from a failing tier, not the unittest dump.

    An assertion becomes `f(args) returned X, expected Y`, with the test's own
    message (usually the failing input) when it has one. An exception raised
    in the reader's code names the error and the line of their file it came
    from. Anything else falls back to the last line of the output.
    """
    if not output:
        return ""
    if output.startswith("exceeded the"):
        return f"too slow: {output} on the biggest allowed input. Look for work you repeat."
    name = "your function"
    if test_file and test_file.is_file():
        found = FUNCTION.search(test_file.read_text())
        if found:
            name = found.group(1)

    frames = FRAME.findall(output)
    user_frames = [(path, line) for path, line in frames if not harness_frame(path)]
    failure = ASSERTION.search(output)
    if failure and not user_frames:
        comparison, message = failure.group(1), failure.group(2)
        # unittest says "Lists differ: [1, 1] != [9, 4]"; the reader needs the values
        comparison = DIFFER.sub("", comparison)
        # the source lines unittest printed between the test frame and the error
        shown = output[: failure.start()].rsplit('File "', 1)[-1]
        call = SOLVE_CALL.search(" ".join(line.strip() for line in shown.splitlines()))
        if " != " in comparison:
            got, expected = comparison.split(" != ", 1)
            subject = f"{name}({call.group(1)})" if call else name
            text = f"{subject} returned {got}, expected {expected}"
            return f"{text} \u2014 {message}" if message and not call else text
        return message or comparison

    exception = None
    for match in EXCEPTION.finditer(output):
        exception = match
    if exception:
        what = exception.group(1) + (f": {exception.group(2)}" if exception.group(2) else "")
        if user_frames:
            return f"your code raised {what} on line {user_frames[-1][1]}"
        return what
    return output.strip().splitlines()[-1]
