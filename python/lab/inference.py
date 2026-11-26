"""lab.inference: models hosted by Hugging Face, called with the student's own token.

Use this for models that are too large for a laptop. The requests are made by the page with the
official ``@huggingface/inference`` client; Python only sees the answers. Set the token once with
the "HF token" button of the notebook page or with ``await lab.set_hf_token()``.

Every function raises ``lab.LabError`` with a clear message when no token is set.
"""

from . import _media
from ._bridge import api, call

_CHAT_OPTIONS = ("max_tokens", "temperature", "top_p", "seed", "stop", "frequency_penalty", "presence_penalty")
_IMAGE_OPTIONS = ("negative_prompt", "width", "height", "num_inference_steps", "guidance_scale", "seed")


def _split_options(options, allowed, what):
    provider = options.pop("provider", None)
    unknown = sorted(set(options) - set(allowed))
    if unknown:
        raise TypeError(f"{what} does not take {', '.join(unknown)}. Allowed: provider, {', '.join(allowed)}")
    return provider, options


@api
async def chat(model, messages, full=False, **options):
    """Ask a hosted chat model. Returns the reply as a string.

    ``messages`` is a string (one user message) or a list like
    ``[{"role": "system", "content": "..."}, {"role": "user", "content": "..."}]``.
    Options: ``max_tokens``, ``temperature``, ``top_p``, ``seed``, ``stop``, ``frequency_penalty``,
    ``presence_penalty`` and ``provider`` (which inference provider to use; default: Hugging Face
    chooses). ``full=True`` returns the whole response as a dict (choices, usage, ...).
    """
    if isinstance(messages, str):
        messages = [{"role": "user", "content": messages}]
    messages = [{"role": str(m["role"]), "content": str(m["content"])} for m in messages]
    provider, options = _split_options(options, _CHAT_OPTIONS, "lab.inference.chat")
    result = await call("inference.chat", model=model, messages=messages, options=options, provider=provider)
    return result["response"] if full else result["text"]


@api
async def text_to_image(model, prompt, **options):
    """Ask a hosted model to draw ``prompt``. Returns a :class:`lab.Image`.

    The image is shown when the call is the last line of a cell; ``lab.show(image)`` shows it
    anywhere, and ``image.data`` holds the encoded bytes. Options: ``negative_prompt``, ``width``,
    ``height``, ``num_inference_steps``, ``guidance_scale``, ``seed`` and ``provider``.
    """
    from . import Image

    provider, options = _split_options(options, _IMAGE_OPTIONS, "lab.inference.text_to_image")
    result = await call("inference.text_to_image", model=model, prompt=str(prompt), options=options, provider=provider)
    return Image(result["data"], result.get("mime") or None)


@api
async def asr(model, audio, sr=16000, provider=None):
    """Transcribe speech with a hosted model. Returns a dict with the key ``"text"``.

    ``audio`` is a mono NumPy array (values from -1 to 1, at ``sr`` samples per second) or the bytes
    of an audio file.
    """
    if isinstance(audio, (bytes, bytearray, memoryview)):
        data = bytes(audio)
    else:
        data = _media.wav_bytes(audio, sr)
    return await call("inference.asr", model=model, data=data, provider=provider)


__all__ = ["chat", "text_to_image", "asr"]
