"""Running one notebook cell inside Pyodide. Used by the worker (src/runtime/worker.ts) only."""

import builtins
import inspect
import io
import json
import linecache
import sys
import traceback

from pyodide.code import eval_code_async

from . import _bridge
from ._display import bundle

_AWAIT_HINT = (
    "Hint: functions that wait for the browser (loading or running a model, audio, the microphone, "
    "hosted models) need `await` in front, for example `result = await pipe(x)`."
)


class _Stream(io.TextIOBase):
    """sys.stdout / sys.stderr: every write goes to the running cell at once."""

    def __init__(self, name):
        super().__init__()
        self._name = name

    def writable(self):
        return True

    def isatty(self):
        return False

    def write(self, text):
        if not isinstance(text, str):
            raise TypeError(f"write() argument must be str, not {type(text).__name__}")
        if text:
            _bridge._backend.stream(self._name, text)
        return len(text)

    def flush(self):
        _bridge._backend.flush()


def _no_input(prompt=""):
    raise RuntimeError("input() is not available in this notebook. Put the value in a variable instead.")


def namespace():
    """The namespace cells run in: the ``__main__`` module, as in Jupyter."""
    import __main__

    return __main__.__dict__


def install():
    """Called once after Python starts."""
    import lab

    sys.stdout = _Stream("stdout")
    sys.stderr = _Stream("stderr")
    builtins.input = _no_input
    namespace()["display"] = lab.display


def _show_figures():
    """Best effort, untested: show open matplotlib figures as images after a cell, like Jupyter's inline backend."""
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None:
        return
    try:
        import base64

        for number in pyplot.get_fignums():
            buffer = io.BytesIO()
            pyplot.figure(number).savefig(buffer, format="png", bbox_inches="tight")
            _bridge.emit(
                {
                    "output_type": "display_data",
                    "data": {"image/png": base64.b64encode(buffer.getvalue()).decode("ascii"), "text/plain": "<Figure>"},
                    "metadata": {},
                }
            )
        pyplot.close("all")
    except Exception:  # noqa: BLE001
        pass


def _is_machinery(frame):
    """Frames a student did not write: the notebook runner, Pyodide's own code, and lab itself."""
    name = frame.filename
    return "/site-packages/lab/" in name or "/pyodide/" in name or "/_pyodide/" in name


def _trim(exception, seen):
    """Remove the machinery frames from a traceback (and from the exceptions it was raised from)."""
    if exception is None or id(exception) in seen:
        return
    seen.add(id(exception))
    exception.stack = traceback.StackSummary.from_list([frame for frame in exception.stack if not _is_machinery(frame)])
    _trim(exception.__cause__, seen)
    _trim(exception.__context__, seen)


def _error(err):
    details = traceback.TracebackException.from_exception(err)
    _trim(details, set())
    lines = "".join(details.format()).rstrip("\n").split("\n")
    message = str(err)
    if "coroutine" in message and isinstance(err, (TypeError, AttributeError)):
        lines += ["", _AWAIT_HINT]
    return {"ok": False, "ename": type(err).__name__, "evalue": message, "traceback": lines}


async def run_cell(source, label):
    """Run the source of one cell. Returns JSON: ``{"ok": true}`` or the error for the notebook."""
    filename = f"<cell [{label}]>"
    # Lets tracebacks show the lines of this cell.
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
    try:
        value = await eval_code_async(
            source, globals=namespace(), filename=filename, return_mode="last_expr", quiet_trailing_semicolon=True
        )
        # `pipe(x)` as the last line without `await`: wait for it instead of showing "<coroutine ...>".
        if inspect.isawaitable(value):
            value = await value
        if value is not None:
            namespace()["_"] = value
            _bridge.emit({"output_type": "execute_result", "data": bundle(value), "metadata": {}})
        _show_figures()
        result = {"ok": True}
    except SystemExit:
        result = {"ok": True}
    except BaseException as err:  # noqa: BLE001 - everything a cell raises is shown, not thrown at the page
        result = _error(err)
    finally:
        try:
            sys.stdout.flush()
        except Exception:  # noqa: BLE001
            pass
    return json.dumps(result)
