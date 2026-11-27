"""Turning a Python value into a notebook output (a "MIME bundle": several formats of the same thing)."""

import base64

_REPR_METHODS = (
    ("_repr_html_", "text/html"),
    ("_repr_markdown_", "text/markdown"),
    ("_repr_svg_", "image/svg+xml"),
    ("_repr_png_", "image/png"),
    ("_repr_jpeg_", "image/jpeg"),
)


def _text(value):
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode("ascii")
    return str(value)


def bundle(obj):
    """All the formats ``obj`` offers, always including ``text/plain`` (its repr)."""
    try:
        data = {"text/plain": repr(obj)}
    except Exception as err:  # noqa: BLE001 - a broken __repr__ must not hide the value's other formats
        data = {"text/plain": f"<{type(obj).__name__} object (repr failed: {err})>"}
    if isinstance(obj, type):
        return data
    method = getattr(obj, "_repr_mimebundle_", None)
    if callable(method):
        try:
            result = method()
            if isinstance(result, tuple):
                result = result[0]
            if isinstance(result, dict):
                for mime, value in result.items():
                    data[str(mime)] = value if isinstance(value, (dict, list)) else _text(value)
        except Exception:  # noqa: BLE001
            pass
    for name, mime in _REPR_METHODS:
        method = getattr(obj, name, None)
        if not callable(method) or mime in data:
            continue
        try:
            result = method()
        except Exception:  # noqa: BLE001
            continue
        if isinstance(result, tuple):
            result = result[0]
        if result is not None:
            data[mime] = _text(result)
    return data
