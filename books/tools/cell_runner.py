"""Run one runnable cell after the cells before it.

The local preview runs this in a subprocess (`preview.run_cell`); the
published site runs the same file in Python in the reader's browser.
Earlier cells set the stage quietly; a failure among them is reported only
if the current cell then fails, since it may explain why.
"""
import contextlib, io, traceback
def _run_cells(_earlier_cells, _own_source):
    _namespace = globals()
    _execute = exec
    _compile = compile
    _string_io = io.StringIO
    _redirect_stdout = contextlib.redirect_stdout
    _redirect_stderr = contextlib.redirect_stderr
    _format_exception = traceback.format_exc
    _first_earlier_failure = None
    for _cell in _earlier_cells:
        _quiet = _string_io()
        try:
            with _redirect_stdout(_quiet), _redirect_stderr(_quiet):
                _execute(_compile(_cell['source'], '<earlier cell>', 'exec'), _namespace, _namespace)
        except Exception:
            if _first_earlier_failure is None:
                _first_earlier_failure = (_cell, _format_exception())
    try:
        _execute(_compile(_own_source, '<current cell>', 'exec'), _namespace, _namespace)
    except Exception:
        if _first_earlier_failure is not None:
            _cell, _trace = _first_earlier_failure
            print(f"Earlier cell {_cell['index']} failed; shared state may be incomplete.")
            print('Source:\n' + _cell['source'])
            print(_trace)
        raise
