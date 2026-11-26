"""A stand-in for the browser side of ``lab`` (the ``_lab_js`` module), for tests under CPython.

It speaks the same protocol as src/runtime/bridge.ts: ``call`` and ``call_sync`` take a method name,
a JSON string and a list of buffers and answer with an object that has ``json`` and ``buffers``.
The "models" are deterministic functions of their input, so tests can predict the results. This
lets the real ``lab`` package and the sample notebooks run with real NumPy and without a browser.
"""

import hashlib
import json
import math
import types

import numpy as np

outputs = []  # everything emitted with lab.html / lab.show / lab.play / lab.table / display
streams = []
calls = []  # (method, params) of every bridge call
token_set = False

VOCAB = [" the", " cat", " sat", " on", " mat", ".", " a", " dog", " Paris", " is", " France", " of", " capital", "The"]
VOCAB += [f" word{i}" for i in range(50)]


def _decode_params(payload, buffers):
    def hook(obj):
        if "__nd__" in obj:
            return np.frombuffer(memoryview(buffers[obj["__nd__"]]).cast("B"), dtype=obj["dtype"]).reshape(obj["shape"])
        if "__bytes__" in obj:
            return bytes(buffers[obj["__bytes__"]])
        return obj

    return json.loads(payload, object_hook=hook)


def _wire(value):
    buffers = []

    def walk(v):
        if isinstance(v, np.ndarray):
            buffers.append(np.ascontiguousarray(v).tobytes())
            return {"__nd__": len(buffers) - 1, "dtype": v.dtype.name, "shape": list(v.shape)}
        if isinstance(v, (bytes, bytearray)):
            buffers.append(bytes(v))
            return {"__bytes__": len(buffers) - 1}
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [walk(x) for x in v]
        return v

    return types.SimpleNamespace(json=json.dumps(walk(value)), buffers=buffers)


class JsError(Exception):
    """Looks like the JsException Pyodide raises: it has ``name`` and ``message``."""

    def __init__(self, name, message):
        super().__init__(f"{name}: {message}")
        self.name = name
        self.message = message


def _tokens(text):
    out, rest = [], text
    while rest:
        for i, token in sorted(enumerate(VOCAB), key=lambda pair: -len(pair[1])):
            if rest.startswith(token):
                out.append(i)
                rest = rest[len(token):]
                break
        else:
            # Unknown text: map each word to one of the filler tokens, deterministically.
            word, _, rest = rest.lstrip().partition(" ")
            rest = (" " + rest) if rest else ""
            out.append(14 + int(hashlib.md5(word.encode()).hexdigest(), 16) % 50)
    return out


def _logits(text):
    """Deterministic float32 logits over the vocabulary, depending on the text."""
    seed = int(hashlib.md5(text.encode()).hexdigest()[:8], 16)
    rng = np.random.default_rng(seed)
    return (rng.standard_normal(len(VOCAB)) * 2.0).astype(np.float32)


_pipelines = {}


def _pipeline_call(params):
    info = _pipelines[params["id"]]
    inputs, options = params["inputs"], params["options"]
    task = info["task"]
    if task == "automatic-speech-recognition":
        audio = inputs[0]
        assert isinstance(audio, np.ndarray) and audio.ndim == 1, "ASR needs a one-dimensional array"
        text = " And so my fellow Americans ask not what your country can do for you, ask what you can do for your country."
        out = {"text": text}
        if options.get("return_timestamps"):
            seconds = len(audio) / 16000
            out["chunks"] = [{"timestamp": [0.0, seconds / 2], "text": text[:60]}, {"timestamp": [seconds / 2, seconds], "text": text[60:]}]
        return out
    if task == "text-to-speech":
        n = int(16000 * 0.35 * len(inputs[0].split()))
        wave = (0.4 * np.sin(2 * np.pi * 220 * np.arange(n) / 16000)).astype(np.float32)
        return {"audio": wave, "sampling_rate": 16000}
    if task == "text-generation":
        return [{"generated_text": inputs[0] + " Paris."}]
    raise JsError("LabError", f"Could not load {info['model']}: Unsupported pipeline: {task}")


async def call(method, payload, buffers):
    params = _decode_params(payload, buffers)
    calls.append((method, params))
    if method == "pipeline.create":
        key = json.dumps([params["task"], params["model"], params["device"], params["dtype"]])
        if key not in _pipelines:
            device = "wasm" if params["device"] in ("auto", None) else params["device"]
            info = {"id": len(_pipelines) + 1, "task": params["task"], "model": params["model"] or "(default)", "device": device, "dtype": params["dtype"], "size_mb": 3.0, "load_seconds": 0.1}
            _pipelines[key] = info
            _pipelines[info["id"]] = info
        return _wire(_pipelines[key])
    if method == "pipeline.call":
        return _wire(_pipeline_call(params))
    if method == "tokenizer.load":
        return _wire({"id": 1, "model": params["model"]})
    if method == "lm.logits":
        return _wire({"logits": _logits(params["text"])})
    if method == "lm.probs":
        logits = _logits(params["text"]).astype(np.float64)
        probs = np.exp(logits - logits.max())
        probs /= probs.sum()
        order = np.argsort(-probs)[: params["top_k"]]
        return _wire({"top": [{"id": int(i), "token": VOCAB[i], "probability": float(probs[i])} for i in order]})
    if method == "audio.load":
        sr = params["sr"]
        n = sr * 11 if "url" in params else sr
        wave = (0.3 * np.sin(2 * np.pi * 330 * np.arange(n) / sr)).astype(np.float32)
        return _wire({"samples": wave, "sr": sr})
    if method == "audio.record":
        n = int(params["sr"] * params["seconds"])
        return _wire({"samples": np.zeros(n, dtype=np.float32), "sr": params["sr"]})
    if method == "token.dialog":
        return _wire({"set": token_set})
    if method.startswith("inference."):
        if not token_set:
            raise JsError("LabError", "No Hugging Face token is set.")
        if method == "inference.chat":
            return _wire({"text": "A reply.", "response": {"choices": [{"message": {"content": "A reply."}}]}})
        if method == "inference.asr":
            return _wire({"text": f"{len(params['data'])} bytes"})
        return _wire({"data": b"\x89PNG\r\n\x1a\n" + b"\x00" * 8, "mime": "image/png"})
    raise JsError("LabError", f"lab: unknown bridge method {method}")


def call_sync(method, payload, buffers):
    params = _decode_params(payload, buffers)
    calls.append((method, params))
    if method == "device":
        return _wire({"webgpu": False, "adapter": None, "shader_f16": False, "browser": "CPython test", "user_agent": "CPython test", "cross_origin_isolated": False, "cpu_threads": 4, "device_memory_gb": None, "jspi": False, "python": "3", "pyodide": "none"})
    if method == "token.status":
        return _wire({"set": token_set})
    if method == "tokenizer.encode":
        return _wire(_tokens(params["text"]))
    if method == "tokenizer.decode":
        return _wire("".join(VOCAB[i] for i in params["ids"]))
    if method == "tokenizer.tokens":
        return _wire([VOCAB[i].replace(" ", "Ġ") for i in _tokens(params["text"])])
    raise JsError("LabError", f"lab: unknown bridge method {method}")


def emit(payload):
    outputs.append(json.loads(payload))


def stream(name, text):
    streams.append((name, text))


def flush():
    pass


def reset():
    outputs.clear()
    streams.clear()
    calls.clear()
    _pipelines.clear()
    globals()["token_set"] = False
