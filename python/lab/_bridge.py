"""The Python side of the bridge: calling JavaScript and turning the answer into Python data.

JavaScript lives in the module ``_lab_js`` that the notebook's worker registers before any cell
runs (src/runtime/bridge.ts). It offers four functions: ``call`` (returns a promise), ``call_sync``,
``emit`` (an output for the running cell) and ``stream`` (text for stdout or stderr).

Waiting for JavaScript
----------------------
Loading a model, decoding audio or asking a hosted model takes time, and the browser cannot block
while it waits. So those functions are coroutines and a notebook writes ``await`` in front of them::

    result = await pipe(audio)

Browsers with JavaScript Promise Integration ("JSPI", checked with ``pyodide.ffi.can_run_sync()``)
can also suspend Python in the middle of a call. There the same functions wait by themselves and
return the finished result, so ``result = pipe(audio)`` works too, also inside an ordinary ``def``.
To keep one notebook working everywhere, a result returned that way can still be awaited: awaiting
a finished result simply gives the result back (as a plain dict, list, array, ...).
"""

import functools
import json

from . import _convert

try:
    import _lab_js as _backend
except ImportError:  # not inside the browser notebook
    _backend = None

try:
    from pyodide.ffi import can_run_sync as _can_run_sync
    from pyodide.ffi import run_sync as _run_sync
    from pyodide.ffi import to_js as _to_js
except ImportError:  # CPython, in tests

    def _can_run_sync():
        return False

    def _run_sync(_awaitable):
        raise RuntimeError("run_sync needs Pyodide")

    def _to_js(value):
        return value


class LabError(RuntimeError):
    """Something the browser side of ``lab`` could not do. The message says what and how to fix it."""


# Shown in tracebacks as "lab.LabError", the name notebooks use to catch it.
LabError.__module__ = "lab"


_ERROR_TYPES = {
    "LabError": LabError,
    "PermissionError": PermissionError,
    "ValueError": ValueError,
    "TypeError": TypeError,
    "KeyError": KeyError,
}


def _translate(err):
    """A JavaScript error -> the matching Python exception, without the JavaScript stack."""
    name = getattr(err, "name", None)
    message = getattr(err, "message", None)
    if not isinstance(name, str) or not isinstance(message, str):
        return err
    return _ERROR_TYPES.get(name, LabError)(message)


def _require_backend():
    if _backend is None:
        raise LabError("lab only works inside the browser notebook (the _lab_js module is missing).")
    return _backend


async def call(method, **params):
    """Call an asynchronous bridge method and return its result as Python data."""
    backend = _require_backend()
    payload, buffers = _convert.encode(params)
    try:
        result = await backend.call(method, payload, _to_js(buffers))
    except Exception as err:  # noqa: BLE001 - JavaScript errors arrive as JsException
        raise _translate(err) from None
    return _convert.decode(result.json, result.buffers)


def call_sync(method, **params):
    """Call a bridge method that answers at once."""
    backend = _require_backend()
    payload, buffers = _convert.encode(params)
    try:
        result = backend.call_sync(method, payload, _to_js(buffers))
    except Exception as err:  # noqa: BLE001
        raise _translate(err) from None
    return _convert.decode(result.json, result.buffers)


def emit(output):
    """Send one notebook output (nbformat's display_data or execute_result) to the running cell."""
    _require_backend().emit(json.dumps(output))


# --- with or without await -----------------------------------------------------------------------

_sync = {"enabled": True}


def sync_calls(enabled=None):
    """Whether lab functions wait by themselves when the browser allows it (JSPI).

    ``lab.sync_calls()`` reports the current state: True only if the browser supports it *and* it has
    not been switched off. ``lab.sync_calls(False)`` switches it off, so that every function returns
    an awaitable as in browsers without JSPI; ``lab.sync_calls(True)`` switches it back on.
    """
    if enabled is not None:
        _sync["enabled"] = bool(enabled)
    return bool(_sync["enabled"] and _can_run_sync())


# A finished result that can also be awaited is a subclass of the plain type whose __await__ gives
# back the *plain* value. It must not give back itself: JavaScript treats an awaitable Python object
# as a "thenable" and would keep awaiting it forever when it passes through a promise.


def _awaits_to(plain):
    def __await__(self):
        return plain(self)
        yield  # pragma: no cover - makes this a generator, which is what __await__ must return

    return __await__


class _Dict(dict):
    __slots__ = ()
    __await__ = _awaits_to(dict)


class _List(list):
    __slots__ = ()
    __await__ = _awaits_to(list)


class _Tuple(tuple):
    __slots__ = ()
    __await__ = _awaits_to(tuple)


class _Str(str):
    __slots__ = ()
    __await__ = _awaits_to(str)


class _Bytes(bytes):
    __slots__ = ()
    __await__ = _awaits_to(bytes)


class _Float(float):
    __slots__ = ()
    __await__ = _awaits_to(float)


class _Int(int):
    __slots__ = ()
    __await__ = _awaits_to(int)


_WRAPPERS = ((dict, _Dict), (list, _List), (tuple, _Tuple), (str, _Str), (bytes, _Bytes), (float, _Float), (int, _Int))

_array_type = None


def _awaitable_array(value):
    global _array_type
    if _array_type is None:
        import numpy

        # Named "array" so that repr() looks exactly like an ordinary NumPy array.
        class array(numpy.ndarray):  # noqa: N801
            def __await__(self):
                return self.view(numpy.ndarray)
                yield  # pragma: no cover

        _array_type = array
    return value.view(_array_type)


class Result:
    """Base class of lab's own result objects (Pipeline, Tokenizer, Image, TokenStatus)."""


_result_types = {}


def _awaitable_result(value):
    """The same object state as ``value``, in a subclass that can be awaited to get a plain object."""
    cls = type(value)
    awaitable = _result_types.get(cls)
    if awaitable is None:

        def __await__(self):
            plain = object.__new__(cls)
            plain.__dict__ = self.__dict__
            return plain
            yield  # pragma: no cover

        awaitable = type(cls.__name__, (cls,), {"__await__": __await__, "__module__": cls.__module__})
        _result_types[cls] = awaitable
    wrapped = object.__new__(awaitable)
    wrapped.__dict__ = value.__dict__
    return wrapped


def finished(value):
    """Wrap a finished result so that ``await`` on it also works (see the module docstring).

    ``None`` and booleans cannot be wrapped; lab functions do not return them from waiting calls.
    """
    if value is None or isinstance(value, bool):
        return value
    for plain, wrapper in _WRAPPERS:
        if type(value) is plain:
            return wrapper(value)
    if type(value).__module__ != "builtins" and isinstance(value, Result):
        return _awaitable_result(value)
    if _convert._is_array(value) and type(value).__name__ == "ndarray":
        return _awaitable_array(value)
    return value


def api(fn):
    """Decorator for lab functions that wait on JavaScript (written as ``async def``)."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        coroutine = fn(*args, **kwargs)
        if _sync["enabled"] and _can_run_sync():
            return finished(_run_sync(coroutine))
        return coroutine

    return wrapper
