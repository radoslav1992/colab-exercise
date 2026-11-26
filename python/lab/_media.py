"""Images, sound and tables as notebook outputs. Pure Python (plus NumPy for arrays), no browser needed."""

import base64
import html as _html
import struct
import zlib

_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)


def sniff_image(data):
    """The MIME type of encoded image bytes, or None if they are not PNG, JPEG, GIF or WebP."""
    head = bytes(data[:12])
    for signature, mime in _SIGNATURES:
        if head.startswith(signature):
            return mime
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return None


def _chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def png_bytes(image):
    """Encode an array as PNG.

    Accepted shapes: (height, width) for grey, (height, width, 3) for RGB, (height, width, 4) for
    RGBA, and (height, width, 1). Floats are read as 0.0 to 1.0, integers as 0 to 255, booleans as
    black and white. Values outside the range are clipped.
    """
    import numpy as np

    arr = np.asarray(image)
    if arr.ndim == 3 and arr.shape[2] == 1:
        arr = arr[:, :, 0]
    if arr.ndim == 2:
        color_type = 0
    elif arr.ndim == 3 and arr.shape[2] == 3:
        color_type = 2
    elif arr.ndim == 3 and arr.shape[2] == 4:
        color_type = 6
    else:
        raise ValueError(
            f"lab.show needs an image of shape (height, width), (height, width, 3) or (height, width, 4), got {arr.shape}"
        )
    if arr.shape[0] == 0 or arr.shape[1] == 0:
        raise ValueError("lab.show cannot show an empty image")
    if arr.dtype == np.bool_:
        pixels = arr.astype(np.uint8) * 255
    elif np.issubdtype(arr.dtype, np.floating):
        pixels = (np.clip(np.nan_to_num(arr), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    elif np.issubdtype(arr.dtype, np.integer):
        pixels = np.clip(arr, 0, 255).astype(np.uint8)
    else:
        raise ValueError(f"lab.show cannot show an array of dtype {arr.dtype}")
    height, width = pixels.shape[:2]
    rows = pixels.reshape(height, -1)
    # Every row starts with a filter byte; 0 means "no filter".
    raw = np.concatenate([np.zeros((height, 1), dtype=np.uint8), rows], axis=1).tobytes()
    header = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header) + _chunk(b"IDAT", zlib.compress(raw, 6)) + _chunk(b"IEND", b"")


def wav_bytes(samples, sr):
    """Encode mono samples in the range -1.0 to 1.0 as a 16-bit PCM WAV file."""
    sr = int(sr)
    if sr <= 0:
        raise ValueError("the sample rate must be a positive number")
    try:
        import numpy as np
    except ImportError:
        np = None
    if np is not None:
        arr = np.asarray(samples)
        if arr.ndim != 1:
            raise ValueError(f"lab.play needs a one-dimensional (mono) array, got shape {arr.shape}")
        if np.issubdtype(arr.dtype, np.integer):
            arr = arr.astype(np.float64) / 32768.0
        pcm = (np.clip(np.nan_to_num(arr.astype(np.float64)), -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    else:
        from array import array
        import sys

        values = array("h", (int(max(-1.0, min(1.0, float(x))) * 32767.0) for x in samples))
        if sys.byteorder == "big":
            values.byteswap()
        pcm = values.tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16)
    return header + fmt + b"data" + struct.pack("<I", len(pcm)) + pcm


def b64(data):
    return base64.b64encode(data).decode("ascii")


def audio_html(wav):
    return f'<audio controls preload="metadata" src="data:audio/wav;base64,{b64(wav)}"></audio>'


def _cell(value):
    if isinstance(value, float):
        text = f"{value:.6g}"
    else:
        text = str(value)
    return _html.escape(text)


def table_html(rows, columns=None, max_rows=200):
    """Rows (a list of dicts, a list of lists, or a 2-D array) -> an HTML table. All text is escaped."""
    rows = list(rows.tolist()) if hasattr(rows, "tolist") else list(rows)
    if rows and isinstance(rows[0], dict):
        if columns is None:
            columns = []
            for row in rows:
                for key in row:
                    if key not in columns:
                        columns.append(key)
        body = [[row.get(col, "") for col in columns] for row in rows]
    else:
        body = [list(row) if isinstance(row, (list, tuple)) else [row] for row in rows]
    hidden = max(0, len(body) - max_rows)
    body = body[:max_rows]
    parts = ['<table class="lab-table">']
    if columns is not None:
        parts.append("<thead><tr>" + "".join(f'<th scope="col">{_cell(c)}</th>' for c in columns) + "</tr></thead>")
    parts.append("<tbody>")
    for row in body:
        parts.append("<tr>" + "".join(f"<td>{_cell(v)}</td>" for v in row) + "</tr>")
    parts.append("</tbody></table>")
    if hidden:
        parts.append(f"<p>… and {hidden} more rows</p>")
    return "".join(parts)


def table_text(rows, columns=None, max_rows=200):
    rows = list(rows.tolist()) if hasattr(rows, "tolist") else list(rows)
    if rows and isinstance(rows[0], dict):
        if columns is None:
            columns = list(rows[0])
        body = [[row.get(col, "") for col in columns] for row in rows]
    else:
        body = [list(row) if isinstance(row, (list, tuple)) else [row] for row in rows]
    lines = []
    if columns is not None:
        lines.append("\t".join(str(c) for c in columns))
    lines.extend("\t".join(f"{v:.6g}" if isinstance(v, float) else str(v) for v in row) for row in body[:max_rows])
    return "\n".join(lines)
