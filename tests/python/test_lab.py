"""The ``lab`` package under CPython with real NumPy: conversion, media encoders, awaitable results, errors."""

import array
import asyncio
import base64
import io
import struct
import sys
import unittest
import wave
import zlib

import numpy as np

import notebook_runner


def decode_png(data):
    """A minimal PNG reader for the files lab writes (8 bit, no interlace, filter 0). Returns an array."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, chunks = 8, {}
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        (crc,) = struct.unpack(">I", data[pos + 8 + length : pos + 12 + length])
        assert crc == zlib.crc32(kind + body) & 0xFFFFFFFF, "chunk checksum"
        chunks.setdefault(kind, b"")
        chunks[kind] += body
        pos += 12 + length
    width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", chunks[b"IHDR"])
    assert depth == 8 and interlace == 0
    channels = {0: 1, 2: 3, 6: 4}[color]
    raw = np.frombuffer(zlib.decompress(chunks[b"IDAT"]), dtype=np.uint8).reshape(height, 1 + width * channels)
    assert np.all(raw[:, 0] == 0)
    return raw[:, 1:].reshape(height, width, channels)


class LabTestCase(unittest.TestCase):
    def setUp(self):
        self.fake = notebook_runner.install_lab()
        import lab

        self.lab = lab

    def wait(self, awaitable):
        return asyncio.run(self._await(awaitable))

    @staticmethod
    async def _await(awaitable):
        return await awaitable


class Convert(LabTestCase):
    def roundtrip(self, value):
        from lab import _convert

        text, buffers = _convert.encode(value)
        return _convert.decode(text, [np.asarray(b).tobytes() if not isinstance(b, bytes) else b for b in buffers])

    def test_plain_values(self):
        value = {"a": [1, 2.5, None, True, "text"], "b": {"c": []}}
        self.assertEqual(self.roundtrip(value), value)
        self.assertEqual(self.roundtrip((1, 2)), [1, 2])

    def test_arrays_keep_dtype_shape_and_values(self):
        for dtype in ("float32", "float64", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64"):
            original = (np.arange(24) % 7).astype(dtype).reshape(2, 3, 4)
            result = self.roundtrip({"x": original})["x"]
            self.assertEqual(result.dtype, original.dtype)
            self.assertEqual(result.shape, original.shape)
            self.assertTrue(np.array_equal(result, original))
            self.assertTrue(result.flags.writeable, "results can be modified")

    def test_special_arrays(self):
        self.assertEqual(self.roundtrip(np.array([True, False])).dtype, np.uint8)
        self.assertEqual(self.roundtrip(np.array([1.5], dtype=np.float16)).dtype, np.float32)
        self.assertEqual(self.roundtrip(np.float32(1.5)), 1.5)
        self.assertEqual(self.roundtrip(np.array(3)), 3)
        sliced = np.arange(10, dtype=np.float32)[::2]
        self.assertTrue(np.array_equal(self.roundtrip(sliced), [0, 2, 4, 6, 8]), "non-contiguous arrays")
        self.assertTrue(np.array_equal(self.roundtrip(np.zeros((0, 3), dtype=np.float32)), np.zeros((0, 3))))
        self.assertEqual(self.roundtrip(array.array("f", [0.5, 1.5])).tolist(), [0.5, 1.5])

    def test_bytes(self):
        self.assertEqual(self.roundtrip({"data": b"\x00\x01\xff"}), {"data": b"\x00\x01\xff"})
        self.assertEqual(self.roundtrip(bytearray(b"ab")), b"ab")

    def test_unsupported_values(self):
        from lab import _convert

        with self.assertRaisesRegex(TypeError, "cannot send a value of type object"):
            _convert.encode({"x": object()})
        with self.assertRaisesRegex(TypeError, "dtype complex128"):
            _convert.encode(np.array([1j]))

    def test_without_numpy_arrays_become_nested_lists_with_one_warning(self):
        from lab import _convert

        data = np.arange(6, dtype=np.float32).tobytes()
        text = '{"__nd__": 0, "dtype": "float32", "shape": [2, 3]}'
        original, _convert._numpy = _convert._numpy, lambda: None
        try:
            _convert._warned_no_numpy = False
            with self.assertWarnsRegex(RuntimeWarning, "NumPy could not be loaded"):
                result = _convert.decode(text, [data])
            self.assertEqual(result, [[0.0, 1.0, 2.0], [3.0, 4.0, 5.0]])
            import warnings

            with warnings.catch_warnings():
                warnings.simplefilter("error")
                _convert.decode(text, [data])  # the warning is given once
        finally:
            _convert._numpy = original


class Media(LabTestCase):
    def test_png_grey_rgb_rgba(self):
        from lab import _media

        grey = np.array([[0.0, 0.5], [1.0, 2.0], [-1.0, np.nan]])
        self.assertEqual(decode_png(_media.png_bytes(grey))[:, :, 0].tolist(), [[0, 128], [255, 255], [0, 0]])
        rgb = np.arange(2 * 3 * 3, dtype=np.uint8).reshape(2, 3, 3)
        self.assertTrue(np.array_equal(decode_png(_media.png_bytes(rgb)), rgb))
        rgba = np.full((4, 5, 4), 300, dtype=np.int64)
        self.assertTrue(np.all(decode_png(_media.png_bytes(rgba)) == 255), "integers are clipped to 0..255")
        mask = np.array([[True, False]])
        self.assertEqual(decode_png(_media.png_bytes(mask))[:, :, 0].tolist(), [[255, 0]])
        self.assertEqual(decode_png(_media.png_bytes(np.zeros((2, 2, 1)))).shape, (2, 2, 1))

    def test_png_rejects_other_shapes(self):
        from lab import _media

        for shape in [(3,), (2, 2, 2), (2, 2, 3, 1), (0, 4)]:
            with self.assertRaises(ValueError):
                _media.png_bytes(np.zeros(shape))

    def test_wav_is_readable_and_correct(self):
        from lab import _media

        samples = np.array([0.0, 0.5, -0.5, 1.0, -1.0, 2.0], dtype=np.float32)
        data = _media.wav_bytes(samples, 16000)
        with wave.open(io.BytesIO(data)) as reader:
            self.assertEqual((reader.getnchannels(), reader.getsampwidth(), reader.getframerate(), reader.getnframes()), (1, 2, 16000, 6))
            pcm = np.frombuffer(reader.readframes(6), dtype="<i2")
        self.assertEqual(pcm.tolist(), [0, 16383, -16383, 32767, -32767, 32767])
        self.assertEqual(_media.wav_bytes([0.0, 0.5, -0.5, 1.0, -1.0, 2.0], 16000), data, "lists give the same file")
        with self.assertRaises(ValueError):
            _media.wav_bytes(np.zeros((2, 2)), 16000)
        with self.assertRaises(ValueError):
            _media.wav_bytes([0.0], 0)

    def test_sniff_image(self):
        from lab import _media

        self.assertEqual(_media.sniff_image(b"\x89PNG\r\n\x1a\n...."), "image/png")
        self.assertEqual(_media.sniff_image(b"\xff\xd8\xff\xe0...."), "image/jpeg")
        self.assertEqual(_media.sniff_image(b"RIFF\x00\x00\x00\x00WEBPVP8 "), "image/webp")
        self.assertIsNone(_media.sniff_image(b"<svg onload=alert(1)>"))

    def test_table_escapes_everything(self):
        from lab import _media

        html = _media.table_html([{"<b>": "<script>x</script>", "n": 0.123456789}], max_rows=5)
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;x&lt;/script&gt;", html)
        self.assertIn("&lt;b&gt;", html)
        self.assertIn("<td>0.123457</td>", html)
        many = _media.table_html([[i] for i in range(10)], columns=["i"], max_rows=3)
        self.assertEqual(many.count("<tr>"), 4)
        self.assertIn("7 more rows", many)
        self.assertIn("<td>1</td>", _media.table_html(np.array([[1, 2], [3, 4]])))


class Outputs(LabTestCase):
    def test_show_play_html_table_display(self):
        lab = self.lab
        lab.show(np.zeros((2, 3)))
        lab.show(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="))
        lab.play(np.zeros(8000, dtype=np.float32), 8000)
        lab.html("<b>x</b>")
        lab.table([[1, 2]], columns=["a", "b"])
        lab.display({"k": 1})
        kinds = [sorted(output["data"]) for output in self.fake.outputs]
        self.assertEqual(kinds, [["image/png", "text/plain"], ["image/png", "text/plain"], ["text/html", "text/plain"], ["text/html", "text/plain"], ["text/html", "text/plain"], ["text/plain"]])
        self.assertEqual(self.fake.outputs[0]["data"]["text/plain"], "<image: 3 x 2>")
        self.assertEqual(self.fake.outputs[2]["data"]["text/plain"], "<audio: 1.00 s at 8000 Hz>")
        self.assertTrue(self.fake.outputs[2]["data"]["text/html"].startswith('<audio controls preload="metadata" src="data:audio/wav;base64,'))
        self.assertTrue(all(output["output_type"] == "display_data" and output["metadata"] == {} for output in self.fake.outputs))
        with self.assertRaises(TypeError):
            lab.show("not an image")
        with self.assertRaises(ValueError):
            lab.show(b"not an image")

    def test_display_bundle(self):
        from lab._display import bundle

        class Rich:
            def __repr__(self):
                return "Rich()"

            def _repr_html_(self):
                return "<i>rich</i>"

            def _repr_png_(self):
                return b"\x89PNG"

            def _repr_svg_(self):
                raise RuntimeError("broken")

        data = bundle(Rich())
        self.assertEqual(data, {"text/plain": "Rich()", "text/html": "<i>rich</i>", "image/png": base64.b64encode(b"\x89PNG").decode()})
        self.assertEqual(bundle(Rich), {"text/plain": repr(Rich)}, "a class is not asked for its instance methods")
        self.assertEqual(bundle(self.lab.Image(b"\x89PNG\r\n\x1a\n")), {"text/plain": "<lab.Image image/png, 8 bytes>", "image/png": base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()})


class Api(LabTestCase):
    def test_functions_return_awaitables_and_plain_data(self):
        lab = self.lab
        self.assertFalse(lab.sync_calls(), "no JSPI under CPython")
        pending = lab.pipeline("text-to-speech", "some/model")
        self.assertTrue(asyncio.iscoroutine(pending))
        tts = self.wait(pending)
        self.assertEqual(repr(tts), "<lab.Pipeline text-to-speech some/model on wasm>")
        self.assertEqual((tts.size_mb, tts.device), (3.0, "wasm"))
        speech = self.wait(tts("one two", speaker_embeddings=np.zeros(4, dtype=np.float32)))
        self.assertIs(type(speech), dict)
        self.assertIs(type(speech["audio"]), np.ndarray)
        self.assertEqual((speech["audio"].dtype, speech["sampling_rate"]), (np.float32, 16000))
        sent = self.fake.calls[-1][1]
        self.assertEqual(sent["inputs"], ["one two"])
        self.assertEqual(sent["options"]["speaker_embeddings"].dtype, np.float32, "arrays in options cross as arrays")

    def test_audio_and_tokens(self):
        lab = self.lab
        samples, sr = self.wait(lab.load_audio("https://example.org/a.wav", sr=8000))
        self.assertEqual((samples.shape, samples.dtype, sr), ((88000,), np.float32, 8000))
        samples, sr = self.wait(lab.load_audio(b"RIFF...."))
        self.assertEqual(self.fake.calls[-1], ("audio.load", {"data": b"RIFF....", "sr": 16000}))
        with self.assertRaises(TypeError):
            self.wait(lab.load_audio(123))
        with self.assertRaises(ValueError):
            self.wait(lab.record(0))
        with self.assertRaises(ValueError):
            self.wait(lab.record(61))
        tok = self.wait(lab.tokenizer("m"))
        ids = tok.encode(" the cat sat")
        self.assertEqual(ids, [0, 1, 2])
        self.assertEqual(tok.decode(np.array(ids)), " the cat sat")
        self.assertEqual(tok.decode(1), " cat")
        self.assertEqual(tok.tokens(" the cat"), ["Ġthe", "Ġcat"])
        probs = self.wait(lab.next_token_probs("m", " the cat", top_k=3))
        self.assertEqual(len(probs), 3)
        self.assertTrue(all(isinstance(pair, tuple) and isinstance(pair[0], str) and isinstance(pair[1], float) for pair in probs))
        logits = self.wait(lab.next_token_logits("m", " the cat"))
        self.assertEqual((logits.ndim, logits.dtype), (1, np.float32))
        expected = np.exp(logits.astype(np.float64) - logits.max())
        self.assertAlmostEqual(probs[0][1], float((expected / expected.sum()).max()), places=12)

    def test_javascript_errors_become_python_exceptions(self):
        lab = self.lab
        with self.assertRaises(lab.LabError) as caught:
            self.wait(self.wait(lab.pipeline("no-such-task", "m"))("x"))
        self.assertEqual(str(caught.exception), "Could not load m: Unsupported pipeline: no-such-task")
        self.assertIsNone(caught.exception.__cause__, "the JavaScript error is not chained into the traceback")
        self.assertEqual(lab.LabError.__module__, "lab")
        self.assertTrue(issubclass(lab.LabError, RuntimeError))

    def test_token_and_inference(self):
        lab = self.lab
        self.assertFalse(lab.hf_token())
        self.assertEqual(repr(lab.hf_token()), "<Hugging Face token: not set>")
        with self.assertRaisesRegex(lab.LabError, "No Hugging Face token is set"):
            self.wait(lab.inference.chat("org/model", "hi"))
        self.fake.token_set = True
        self.assertTrue(lab.hf_token())
        self.assertNotIn("hf_", repr(lab.hf_token()))
        self.assertEqual(self.wait(lab.inference.chat("org/model", "hi", max_tokens=5, provider="hf-inference")), "A reply.")
        method, params = self.fake.calls[-1]
        self.assertEqual(params, {"model": "org/model", "messages": [{"role": "user", "content": "hi"}], "options": {"max_tokens": 5}, "provider": "hf-inference"})
        self.assertEqual(self.wait(lab.inference.chat("org/model", [{"role": "user", "content": "hi"}], full=True))["choices"][0]["message"]["content"], "A reply.")
        with self.assertRaisesRegex(TypeError, "does not take endpointUrl"):
            self.wait(lab.inference.chat("org/model", "hi", endpointUrl="https://evil.example"))
        image = self.wait(lab.inference.text_to_image("org/draw", "a dot", width=64))
        self.assertIsInstance(image, lab.Image)
        self.assertEqual(image.mime, "image/png")
        result = self.wait(lab.inference.asr("org/asr", np.zeros(100, dtype=np.float32)))
        self.assertEqual(result, {"text": "244 bytes"}, "arrays are sent as a WAV file: 44 bytes of header and 2 bytes per sample")
        self.assertTrue(self.wait(lab.set_hf_token()))


class FinishedResults(LabTestCase):
    """With JSPI, calls return finished results that can still be awaited (lab/_bridge.py)."""

    def test_awaiting_a_finished_result_gives_the_plain_value(self):
        from lab import _bridge

        cases = [{"a": 1}, [1, 2], (1, "x"), "text", b"bytes", 1.5, 7]
        for value in cases:
            wrapped = _bridge.finished(value)
            self.assertEqual(wrapped, value)
            self.assertIsInstance(wrapped, type(value))
            self.assertEqual(repr(wrapped), repr(value), "it prints like the plain value")
            awaited = self.wait(wrapped)
            self.assertIs(type(awaited), type(value), "awaiting gives the plain type")
            self.assertEqual(awaited, value)
            self.assertFalse(hasattr(awaited, "__await__"), "the awaited value is not awaitable again (no endless thenable)")

    def test_arrays(self):
        from lab import _bridge

        value = np.arange(6, dtype=np.float32).reshape(2, 3)
        wrapped = _bridge.finished(value)
        self.assertEqual(repr(wrapped), repr(value))
        self.assertTrue(np.array_equal(wrapped * 2, value * 2))
        awaited = self.wait(wrapped)
        self.assertIs(type(awaited), np.ndarray)
        self.assertTrue(np.shares_memory(awaited, value))

    def test_lab_objects(self):
        from lab import _bridge

        pipe = self.wait(self.lab.pipeline("text-generation", "m"))
        wrapped = _bridge.finished(pipe)
        self.assertIsInstance(wrapped, self.lab.Pipeline)
        self.assertEqual(repr(wrapped), repr(pipe))
        awaited = self.wait(wrapped)
        self.assertIs(type(awaited), self.lab.Pipeline)
        self.assertEqual(awaited._id, pipe._id)
        self.assertFalse(hasattr(awaited, "__await__"))
        status = _bridge.finished(self.lab.TokenStatus(False))
        self.assertFalse(status)
        self.assertFalse(self.wait(status))

    def test_values_that_cannot_be_wrapped_pass_through(self):
        from lab import _bridge

        self.assertIsNone(_bridge.finished(None))
        self.assertIs(_bridge.finished(True), True)

    def test_api_uses_run_sync_when_the_browser_allows_it(self):
        from lab import _bridge

        ran = []
        original = (_bridge._can_run_sync, _bridge._run_sync)
        _bridge._can_run_sync = lambda: True
        _bridge._run_sync = lambda coroutine: (ran.append(True), asyncio.run(self._await(coroutine)))[1]
        try:
            self.assertTrue(self.lab.sync_calls())
            tok = self.lab.tokenizer("m")  # no await
            self.assertIsInstance(tok, self.lab.Tokenizer)
            self.assertEqual(ran, [True])
            self.assertIs(type(self.wait(tok)), self.lab.Tokenizer, "and await still works")
            self.assertFalse(self.lab.sync_calls(False))
            self.assertTrue(asyncio.iscoroutine(pending := self.lab.tokenizer("m")))
            pending.close()
            self.assertTrue(self.lab.sync_calls(True))
        finally:
            _bridge._can_run_sync, _bridge._run_sync = original


if __name__ == "__main__":
    unittest.main(verbosity=2)
