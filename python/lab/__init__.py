"""lab: what a course notebook uses to reach the browser.

Python in these notebooks runs inside the browser (Pyodide). ``lab`` is a thin bridge to things
that only JavaScript can do there: run models on the graphics card with Transformers.js, decode and
record audio, show images, sound and tables, and call models hosted by Hugging Face.

Functions that have to wait for the browser are awaited::

    import lab

    asr = await lab.pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en")
    audio, sr = await lab.load_audio("https://example.org/speech.wav")
    result = await asr(audio)
    print(result["text"])

In browsers with JSPI (``lab.sync_calls()`` is True) the same calls also work without ``await``.
Keep the ``await`` in notebooks you hand out: it works in every browser.

Results are plain Python data: dicts, lists, strings and NumPy arrays.
"""

from . import _bridge, _media
from . import inference as inference
from ._bridge import LabError, api, call, call_sync, emit, sync_calls

__all__ = [
    "LabError",
    "Image",
    "Pipeline",
    "Tokenizer",
    "device",
    "display",
    "hf_token",
    "html",
    "inference",
    "load_audio",
    "next_token_logits",
    "next_token_probs",
    "pipeline",
    "play",
    "record",
    "set_hf_token",
    "show",
    "sync_calls",
    "table",
    "tokenizer",
]


# --- the machine -----------------------------------------------------------------------------------


def device():
    """What this browser can do, as a dict.

    Keys: ``webgpu`` (True if a graphics adapter is available to the page), ``adapter`` (vendor,
    architecture, device and description if the browser tells; else None), ``shader_f16``,
    ``browser``, ``user_agent``, ``cross_origin_isolated`` (needed for multi-threaded CPU
    fallback), ``cpu_threads``, ``device_memory_gb``, ``jspi``, ``python`` and ``pyodide``.
    """
    return call_sync("device")


# --- models that run in this browser ----------------------------------------------------------------


class Pipeline(_bridge.Result):
    """A loaded Transformers.js pipeline. Call it like a function; see :func:`pipeline`."""

    def __init__(self, info):
        self._id = info["id"]
        self.task = info["task"]
        self.model = info["model"]
        #: Where it runs: "webgpu" (graphics card) or "wasm" (CPU).
        self.device = info["device"]
        self.dtype = info.get("dtype")
        #: Total size of the model files in megabytes, as reported while loading (None if unknown).
        self.size_mb = info.get("size_mb")
        #: Seconds it took to load, including the download if it was not cached yet.
        self.load_seconds = info.get("load_seconds")

    def __repr__(self):
        return f"<lab.Pipeline {self.task} {self.model} on {self.device}>"

    @api
    async def __call__(self, *inputs, **options):
        """Run the model. Positional arguments are the inputs, keyword arguments are the options
        of the Transformers.js pipeline (for example ``return_timestamps=True``, ``max_new_tokens=30``).
        """
        return await call("pipeline.call", id=self._id, inputs=list(inputs), options=options)


@api
async def pipeline(task, model=None, device="auto", dtype=None, **options):
    """Load a model with Transformers.js and return a callable :class:`Pipeline`.

    ``task``    for example "automatic-speech-recognition", "text-to-speech", "text-generation",
                "feature-extraction", "sentiment-analysis".
    ``model``   a model id on the Hugging Face Hub that has ONNX files (many live under "Xenova/"
                and "onnx-community/"). None uses the default of Transformers.js for the task.
    ``device``  "auto" uses the graphics card ("webgpu") when the browser has one and falls back to
                the CPU ("wasm"); or name one of the two yourself.
    ``dtype``   the precision of the weights, for example "fp32", "fp16", "q8", "q4" (or a dict with
                one of these per model file, as Transformers.js allows). None lets Transformers.js choose.

    The first call downloads the model (progress is shown in the status line); the browser caches
    the files. Asking again for the same task, model, device and dtype returns the loaded pipeline.
    """
    info = await call("pipeline.create", task=task, model=model, device=device, dtype=dtype, options=options)
    return Pipeline(info)


class Tokenizer(_bridge.Result):
    """A loaded tokenizer; see :func:`tokenizer`. Its methods answer at once (no ``await``)."""

    def __init__(self, info):
        self._id = info["id"]
        self.model = info["model"]

    def __repr__(self):
        return f"<lab.Tokenizer {self.model}>"

    def encode(self, text):
        """Text -> list of token ids."""
        return call_sync("tokenizer.encode", id=self._id, text=text)

    def decode(self, ids):
        """Token ids (a list, a NumPy array or one id) -> text."""
        if hasattr(ids, "tolist"):
            ids = ids.tolist()
        if isinstance(ids, int):
            ids = [ids]
        return call_sync("tokenizer.decode", id=self._id, ids=[int(i) for i in ids])

    def tokens(self, text):
        """Text -> list of token strings, as the model's vocabulary spells them."""
        return call_sync("tokenizer.tokens", id=self._id, text=text)


@api
async def tokenizer(model):
    """Load the tokenizer of a model (a small download) and return a :class:`Tokenizer`."""
    return Tokenizer(await call("tokenizer.load", model=model))


@api
async def next_token_logits(model, text, device="auto", dtype=None):
    """The raw scores (logits) of a causal language model for the token that follows ``text``.

    Returns a NumPy float32 array with one entry per token of the vocabulary. Apply softmax to get
    probabilities.

    Experimental: written against the Transformers.js API (``AutoModelForCausalLM``) but not yet
    tried with a real model.
    """
    result = await call("lm.logits", model=model, text=text, device=device, dtype=dtype)
    return result["logits"]


@api
async def next_token_probs(model, text, top_k=10, device="auto", dtype=None):
    """The ``top_k`` most likely next tokens after ``text`` as a list of ``(token, probability)``.

    The probabilities are the softmax of the model's logits at the last position (temperature 1).

    Experimental: written against the Transformers.js API (``AutoModelForCausalLM``) but not yet
    tried with a real model.
    """
    result = await call("lm.probs", model=model, text=text, top_k=int(top_k), device=device, dtype=dtype)
    return [(item["token"], item["probability"]) for item in result["top"]]


# --- sound -----------------------------------------------------------------------------------------


@api
async def load_audio(source, sr=16000):
    """Decode an audio file and return ``(samples, sample_rate)``.

    ``source`` is an address (https://...) or the bytes of a file (wav, mp3, ogg, flac, m4a: whatever
    the browser can decode). ``samples`` is a mono NumPy float32 array with values from -1 to 1,
    resampled to ``sr`` samples per second (speech models usually expect 16000).
    """
    if isinstance(source, str):
        result = await call("audio.load", url=source, sr=int(sr))
    elif isinstance(source, (bytes, bytearray, memoryview)):
        result = await call("audio.load", data=bytes(source), sr=int(sr))
    else:
        raise TypeError("lab.load_audio needs an address (str) or the bytes of an audio file")
    return (result["samples"], result["sr"])


@api
async def record(seconds=5, sr=16000):
    """Record from the microphone and return ``(samples, sample_rate)`` like :func:`load_audio`.

    The page asks before it records: a small dialog with a Record button appears, and the browser
    asks for permission to use the microphone the first time. Raises ``PermissionError`` if the
    microphone is refused and ``lab.LabError`` if the recording is cancelled.
    """
    seconds = float(seconds)
    if not 0 < seconds <= 60:
        raise ValueError("lab.record can record between 0 and 60 seconds")
    result = await call("audio.record", seconds=seconds, sr=int(sr))
    return (result["samples"], result["sr"])


def play(samples, sr=16000):
    """Show an audio player for mono samples (values from -1 to 1) at ``sr`` samples per second."""
    wav = _media.wav_bytes(samples, sr)
    seconds = (len(wav) - 44) / 2 / int(sr)
    emit(
        {
            "output_type": "display_data",
            "data": {"text/html": _media.audio_html(wav), "text/plain": f"<audio: {seconds:.2f} s at {int(sr)} Hz>"},
            "metadata": {},
        }
    )


# --- pictures, HTML, tables ------------------------------------------------------------------------


class Image(_bridge.Result):
    """An encoded image (PNG, JPEG, GIF or WebP). Shown when it is the last value of a cell."""

    def __init__(self, data, mime=None):
        self.data = bytes(data)
        self.mime = mime or _media.sniff_image(self.data)
        if self.mime is None:
            raise ValueError("these bytes are not a PNG, JPEG, GIF or WebP image")

    def __repr__(self):
        return f"<lab.Image {self.mime}, {len(self.data)} bytes>"

    def _repr_mimebundle_(self):
        return {self.mime: _media.b64(self.data)}


def show(image):
    """Show an image: a NumPy array, encoded image bytes, or a :class:`lab.Image`.

    Arrays: shape (height, width) is grey, (height, width, 3) is RGB, (height, width, 4) is RGBA.
    Floats are read as 0.0 (black) to 1.0 (white), integers as 0 to 255.
    """
    if isinstance(image, (bytes, bytearray, memoryview)):
        image = Image(image)
    if isinstance(image, Image):
        data, mime, text = image.data, image.mime, repr(image)
    elif hasattr(image, "shape") and hasattr(image, "dtype"):
        data, mime = _media.png_bytes(image), "image/png"
        text = f"<image: {image.shape[1]} x {image.shape[0]}>"
    elif hasattr(image, "_repr_png_"):
        data, mime, text = image._repr_png_(), "image/png", repr(image)
    else:
        raise TypeError("lab.show needs a NumPy array, image bytes or a lab.Image")
    emit({"output_type": "display_data", "data": {mime: _media.b64(data), "text/plain": text}, "metadata": {}})


def html(markup):
    """Show HTML (or SVG) as an output. The page removes scripts and other active content first."""
    emit({"output_type": "display_data", "data": {"text/html": str(markup), "text/plain": "<HTML output>"}, "metadata": {}})


def table(rows, columns=None, max_rows=200):
    """Show a simple table. ``rows`` is a list of dicts, a list of lists, or a 2-D array."""
    emit(
        {
            "output_type": "display_data",
            "data": {
                "text/html": _media.table_html(rows, columns, max_rows),
                "text/plain": _media.table_text(rows, columns, max_rows),
            },
            "metadata": {},
        }
    )


def display(obj):
    """Show a value the way the last line of a cell is shown (text, HTML, image, ...)."""
    from ._display import bundle

    emit({"output_type": "display_data", "data": bundle(obj), "metadata": {}})


# --- the student's Hugging Face token --------------------------------------------------------------


class TokenStatus(_bridge.Result):
    """Whether a Hugging Face token is stored in this browser. True-ish when it is.

    The token itself never enters Python: it stays in the page, which uses it only for requests to
    Hugging Face. That is why this object can be printed without leaking anything.
    """

    def __init__(self, is_set):
        self.is_set = bool(is_set)

    def __bool__(self):
        return self.is_set

    def __repr__(self):
        return "<Hugging Face token: set, kept in this browser only>" if self.is_set else "<Hugging Face token: not set>"


def hf_token():
    """Is a Hugging Face token set in this browser? Returns a :class:`TokenStatus` (use it in ``if``)."""
    return TokenStatus(call_sync("token.status")["set"])


@api
async def set_hf_token():
    """Open the page's token dialog, where you paste, replace or remove your Hugging Face token.

    The token is kept in this browser's storage only. It is not written into the notebook file and
    is sent nowhere except to Hugging Face. Returns a :class:`TokenStatus`.
    """
    return TokenStatus((await call("token.dialog"))["set"])
