"""Moving values between Python and JavaScript.

A value crosses the border as one JSON string plus a list of binary buffers. Inside the JSON, an
array is the placeholder ``{"__nd__": i, "dtype": "float32", "shape": [2, 3]}`` and raw bytes are
``{"__bytes__": i}``, where ``i`` is the buffer's position in the list. JSON keeps the border
simple and predictable (no proxies to clean up, no surprises with ``null``), and the buffers keep
large arrays out of the JSON.

This module has no browser dependencies, so it is tested under ordinary CPython as well.
"""

import array as _array
import json
import sys
import warnings

# dtype name -> struct/memoryview format, for the fallback without NumPy.
_FORMATS = {
    "float32": "f",
    "float64": "d",
    "int8": "b",
    "uint8": "B",
    "int16": "h",
    "uint16": "H",
    "int32": "i",
    "uint32": "I",
    "int64": "q",
    "uint64": "Q",
}

# array.array type code -> dtype name ("l" and "L" depend on the platform, so they go by size).
_TYPECODES = {"f": "float32", "d": "float64", "b": "int8", "B": "uint8", "h": "int16", "H": "uint16", "q": "int64", "Q": "uint64"}

_warned_no_numpy = False


def _array_dtype(values):
    if values.typecode in _TYPECODES:
        return _TYPECODES[values.typecode]
    if values.typecode in "iIlL":
        return ("int" if values.typecode in "il" else "uint") + str(values.itemsize * 8)
    raise TypeError(f"lab cannot send an array.array of type code {values.typecode!r} to JavaScript")


def _numpy():
    """NumPy if it can be imported, else None."""
    try:
        import numpy

        return numpy
    except ImportError:
        return None


def _is_array(value):
    return type(value).__module__.split(".")[0] == "numpy" and hasattr(value, "dtype") and hasattr(value, "shape")


def encode(value):
    """Python value -> (JSON string, list of buffers)."""
    buffers = []

    def walk(v):
        if v is None or isinstance(v, (bool, str)):
            return v
        if isinstance(v, int):
            return int(v)
        if isinstance(v, float):
            return float(v)
        if _is_array(v):
            np = sys.modules["numpy"]
            if v.ndim == 0:
                return v.item()
            arr = np.asarray(v)
            name = arr.dtype.name
            if name == "bool":
                arr, name = arr.astype(np.uint8), "uint8"
            elif name == "float16":
                arr, name = arr.astype(np.float32), "float32"
            if name not in _FORMATS:
                raise TypeError(f"lab cannot send an array of dtype {name} to JavaScript; convert it first, e.g. .astype('float32')")
            buffers.append(np.ascontiguousarray(arr).reshape(-1))
            return {"__nd__": len(buffers) - 1, "dtype": name, "shape": [int(n) for n in arr.shape]}
        if isinstance(v, _array.array):
            # The standard library's typed array: a one-dimensional array without NumPy.
            buffers.append(v)
            return {"__nd__": len(buffers) - 1, "dtype": _array_dtype(v), "shape": [len(v)]}
        if isinstance(v, (bytes, bytearray, memoryview)):
            buffers.append(bytes(v))
            return {"__bytes__": len(buffers) - 1}
        if isinstance(v, dict):
            return {str(k): walk(item) for k, item in v.items()}
        if isinstance(v, (list, tuple)):
            return [walk(item) for item in v]
        raise TypeError(f"lab cannot send a value of type {type(v).__name__} to JavaScript")

    return json.dumps(walk(value)), buffers


def _as_memoryview(buffer):
    # In the browser a buffer is a JavaScript typed array (a proxy with to_py); in tests it is bytes-like.
    if hasattr(buffer, "to_py"):
        buffer = buffer.to_py()
    return memoryview(buffer).cast("B")


def _nested(flat, shape):
    if len(shape) <= 1:
        return flat
    step = len(flat) // shape[0] if shape[0] else 0
    return [_nested(flat[i * step : (i + 1) * step], shape[1:]) for i in range(shape[0])]


def decode(text, buffers):
    """(JSON string, list of buffers) -> Python value. Arrays become NumPy arrays."""

    def hook(obj):
        if "__nd__" in obj:
            raw = _as_memoryview(buffers[obj["__nd__"]])
            dtype, shape = obj["dtype"], obj["shape"]
            np = _numpy()
            if np is not None:
                return np.frombuffer(raw, dtype=dtype).reshape(shape).copy()
            global _warned_no_numpy
            if not _warned_no_numpy:
                _warned_no_numpy = True
                warnings.warn(
                    "NumPy could not be loaded, so arrays from the browser arrive as nested lists. "
                    "Check your internet connection and restart the runtime.",
                    RuntimeWarning,
                    stacklevel=2,
                )
            return _nested(raw.cast(_FORMATS[dtype]).tolist(), shape)
        if "__bytes__" in obj:
            return bytes(_as_memoryview(buffers[obj["__bytes__"]]))
        return obj

    return json.loads(text, object_hook=hook)
