/**
 * End-to-end tests of the `lab` bridge. The model libraries are the stubs in tests/stubs, so these
 * tests prove the plumbing (Python <-> JavaScript conversion, caching, progress, errors, the token
 * boundary, audio through the page) and not the models themselves.
 *
 * NumPy cannot be loaded where these tests usually run. Arrays therefore arrive in Python through
 * the documented fallback (nested lists, with one warning); the NumPy path of the same converter is
 * tested under CPython in tests/python/test_lab.py.
 */
import {
  assert,
  assertEqual,
  assertExcludes,
  assertIncludes,
  cell,
  download,
  hasError,
  notebook,
  openApp,
  openNotebook,
  outputText,
  runAllExpectingNoErrors,
  runCell,
  waitIdle,
  waitSaved,
} from './helpers.mjs'

const TOKEN = 'hf_TESTtoken0123456789abcdefXYZ'

export function register(suite, env) {
  const fresh = async (options = {}, browser = env.browser) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, ...options })
    const app = await openApp(context, env.url)
    return { context, ...app }
  }
  const workerLog = (page, name) => page.workers()[0].evaluate((key) => globalThis[key], name)

  suite.test('lab.device() reports the browser', async () => {
    const { context, page } = await fresh()
    await openNotebook(
      page,
      notebook([
        'import lab\ninfo = lab.device()\nassert isinstance(info, dict)\nfor key in ["webgpu", "adapter", "browser", "cross_origin_isolated", "cpu_threads", "jspi", "python", "pyodide"]:\n    assert key in info, key\nassert info["cross_origin_isolated"] is False\nassert isinstance(info["webgpu"], bool)\nassert info["python"].startswith("3.")\nprint(info)',
      ]),
    )
    const [text] = await runAllExpectingNoErrors(page)
    assertIncludes(text, "'webgpu': False", 'no graphics adapter in the test browser')
    assertIncludes(text, "'pyodide': '314.0.8'", 'the pinned Pyodide version')
    await context.close()
  })

  suite.test('lab.pipeline: loads through the stub, reports progress, falls back to the CPU, caches', async () => {
    const { context, page } = await fresh()
    await page.evaluate(() => {
      window.__statuses = []
      new MutationObserver(() => window.__statuses.push(document.querySelector('.runtime-status').innerText)).observe(
        document.querySelector('.runtime-status'),
        { childList: true, subtree: true, characterData: true },
      )
      window.__progress = []
      new MutationObserver(() => {
        const bar = document.querySelector('.runtime-progress')
        if (!bar.hidden) window.__progress.push(bar.value)
      }).observe(document.querySelector('.runtime-progress'), { attributes: true })
    })
    await openNotebook(
      page,
      notebook([
        `import lab
lab.sync_calls(False)
asr = await lab.pipeline("automatic-speech-recognition", "stub/whisper")
print(repr(asr))
assert asr.device == "wasm", asr.device           # "auto" without a graphics card
assert asr.task == "automatic-speech-recognition" and asr.model == "stub/whisper"
assert asr.size_mb == 3.0, asr.size_mb            # 1 kB + 3 MB reported by the progress events
assert asr.load_seconds >= 0`,
        `again = await lab.pipeline("automatic-speech-recognition", "stub/whisper")
explicit = await lab.pipeline("automatic-speech-recognition", "stub/whisper", device="wasm")
other = await lab.pipeline("automatic-speech-recognition", "stub/other", dtype="q8")
assert again._id == asr._id and explicit._id == asr._id
assert other._id != asr._id and other.dtype == "q8"`,
        `fallback = await lab.pipeline("text-generation", "stub/cpu-only", device="auto")
assert fallback.device == "wasm"`,
      ]),
    )
    const texts = await runAllExpectingNoErrors(page)
    assertIncludes(texts[0], '<lab.Pipeline automatic-speech-recognition stub/whisper on wasm>', 'repr of a pipeline')
    const statuses = await page.evaluate(() => window.__statuses)
    assert(statuses.some((s) => s.includes('Loading Transformers.js')), 'status: loading the library')
    assert(statuses.some((s) => /Loading stub\/whisper: onnx\/model\.onnx \d+%/.test(s)), `status: download progress (${statuses.slice(0, 12).join(' | ')})`)
    const progress = await page.evaluate(() => window.__progress)
    assert(progress.some((value) => value > 0 && value <= 1), 'the progress bar moved')
    const log = await workerLog(page, '__stubLog')
    assertEqual(
      log.pipelines.map((p) => [p.model, p.device, p.dtype ?? null]),
      [
        ['stub/whisper', 'wasm', null],
        ['stub/other', 'wasm', 'q8'],
        ['stub/cpu-only', 'wasm', null],
      ],
      'each pipeline was created once, on the CPU, with the dtype passed through',
    )
    assertEqual(await page.locator('.runtime-status').getAttribute('data-runtime'), 'idle', 'idle afterwards')
    await context.close()
  })

  suite.test('lab.pipeline with a graphics card: "auto" picks webgpu, and falls back with a warning if that fails', async () => {
    // The test browser has no WebGPU, so a fake adapter is put in front of the worker's probe.
    const { context, page } = await fresh()
    await page.route('**/assets/worker-*.js', async (route) => {
      const response = await route.fetch()
      const body = await response.text()
      const fake =
        'Object.defineProperty(self.navigator, "gpu", { value: { requestAdapter: async () => ({ info: { vendor: "testvendor", architecture: "testarch", device: "", description: "Fake GPU" }, features: new Set(["shader-f16"]) }) } });\n'
      await route.fulfill({ response, body: fake + body })
    })
    await page.reload()
    await page.waitForSelector('.cell')
    await openNotebook(
      page,
      notebook([
        `import lab
lab.sync_calls(False)
info = lab.device()
assert info["webgpu"] is True and info["adapter"]["vendor"] == "testvendor" and info["shader_f16"] is True, info
gen = await lab.pipeline("text-generation", "stub/gpt")
assert gen.device == "webgpu", gen.device
cpu = await lab.pipeline("text-generation", "stub/gpt", device="wasm")
assert cpu.device == "wasm" and cpu._id != gen._id`,
        `slow = await lab.pipeline("text-generation", "stub/cpu-only")
assert slow.device == "wasm"`,
      ]),
    )
    const texts = await runAllExpectingNoErrors(page)
    assertIncludes(texts[1], 'did not load on the graphics card', 'the fallback is announced')
    assertIncludes(await page.locator('.runtime-status').innerText(), 'graphics card available (WebGPU)', 'status line names WebGPU')
    const log = await workerLog(page, '__stubLog')
    assertEqual(
      log.pipelines.map((p) => [p.model, p.device]),
      [
        ['stub/gpt', 'webgpu'],
        ['stub/gpt', 'wasm'],
        ['stub/cpu-only', 'webgpu'],
        ['stub/cpu-only', 'wasm'],
      ],
      'devices asked of the library',
    )
    await context.close()
  })

  suite.test('Python <-> JavaScript conversion: inputs, options, tensors, audio, images, big integers', async () => {
    const { context, page } = await fresh()
    await openNotebook(
      page,
      notebook([
        `import array, lab
lab.sync_calls(False)
echo = await lab.pipeline("echo", "stub/echo")
samples = array.array("f", [0.25, 0.5, 0.75])
out = await echo("text", samples, {"nested": [1, 2.5, None, True]}, b"\\x01\\x02", flag=True, count=3, speaker=array.array("d", [1.0, 2.0]))
got = out["received"]
assert got[0] == "text", got
assert got[1] == {"kind": "Float32Array", "length": 3, "first": 0.25}, got[1]
assert got[2] == {"nested": [1, 2.5, None, True]}, got[2]
assert got[3] == {"kind": "Uint8Array", "length": 2, "first": 1}, got[3]
assert got[4] == {"flag": True, "count": 3, "speaker": {"kind": "Float64Array", "length": 2, "first": 1}}, got[4]
assert out["big"] == 12 and out["nothing"] is None
assert out["ids"] == [1, 2, 3], out["ids"]            # an int64 tensor (BigInt64Array)
print("inputs ok")`,
        `features = await lab.pipeline("feature-extraction", "stub/embed")
tensor = await features("hello")
assert tensor == [[[0.0, 0.5, 1.0, 1.5], [2.0, 2.5, 3.0, 3.5], [4.0, 4.5, 5.0, 5.5]]], tensor   # shape (1, 3, 4)
seg = await (await lab.pipeline("image-segmentation", "stub/seg"))("https://example.org/cat.png")
assert seg[0]["label"] == "thing" and seg[0]["score"] == 0.75
assert seg[0]["mask"] == [[[0], [255], [255]], [[0], [255], [0]]], seg[0]["mask"]                 # (height 2, width 3, channels 1)
print("outputs ok")`,
        `asr = await lab.pipeline("automatic-speech-recognition", "stub/whisper")
result = await asr(array.array("f", [0.0] * 32000), return_timestamps=True, chunk_length_s=30)
assert result["text"] == " heard 32000 samples", result
assert result["chunks"] == [{"timestamp": [0, 1.0], "text": " heard"}, {"timestamp": [1.0, 2.0], "text": " 32000 samples"}], result
tts = await lab.pipeline("text-to-speech", "stub/tts")
speech = await tts("hi", speaker_embeddings="https://example.org/speaker.bin")
assert speech["sampling_rate"] == 16000 and len(speech["audio"]) == 3200
assert abs(max(speech["audio"]) - 0.5) < 1e-3
lab.play(speech["audio"], speech["sampling_rate"])
gen = await lab.pipeline("text-generation", "stub/gpt")
assert (await gen("Once", max_new_tokens=7)) == [{"generated_text": "Once and so on (max_new_tokens=7)"}]
print("models ok")`,
      ]),
    )
    const texts = await runAllExpectingNoErrors(page)
    assertIncludes(texts[0], 'inputs ok', 'inputs')
    assertIncludes(texts[1], 'outputs ok', 'outputs')
    assertIncludes(texts[2], 'models ok', 'models')
    const all = texts.join('\n')
    assertIncludes(all, 'NumPy could not be loaded, so arrays from the browser arrive as nested lists', 'the missing NumPy is announced')
    assertEqual(all.split('NumPy could not be loaded').length - 1, 1, 'the warning appears once')
    assertEqual(await cell(page, 2).locator('audio').count(), 1, 'lab.play shows a player for the model output')
    const log = await workerLog(page, '__stubLog')
    const tts = log.calls.find((c) => c.task === 'text-to-speech')
    assertEqual(tts.args, ['hi', { speaker_embeddings: 'https://example.org/speaker.bin' }], 'options reach the pipeline as an object')
    await context.close()
  })

  suite.test('clear error messages: unknown model, failing model, bad device, unsupported value', async () => {
    const { context, page } = await fresh()
    await openNotebook(
      page,
      notebook([
        'import lab\nlab.sync_calls(False)\nawait lab.pipeline("text-generation", "stub/missing")',
        'await lab.pipeline("text-generation", "stub/gpt", device="cuda")',
        'bad = await lab.pipeline("fail", "stub/fail")\nawait bad("x")',
        'await lab.pipeline("no-such-task", "stub/x")',
        'gen = await lab.pipeline("text-generation", "stub/gpt")\nawait gen(object())',
        'gen = await lab.pipeline("text-generation", "stub/gpt")\nresult = gen("no await here")\nresult[0]',
        'try:\n    await lab.pipeline("text-generation", "stub/missing")\nexcept lab.LabError as err:\n    print("caught:", type(err).__name__)',
      ]),
    )
    for (let i = 0; i < 7; i++) await runCell(page, i)
    assertIncludes(await outputText(page, 0), 'lab.LabError: Could not load stub/missing: Could not locate file', 'unknown model')
    assertExcludes(await outputText(page, 0), 'JsException', 'no JavaScript exception type in the message')
    assertExcludes(await outputText(page, 0), 'at async', 'no JavaScript stack')
    assertIncludes(await outputText(page, 1), 'ValueError: device must be "auto", "webgpu" or "wasm", not "cuda"', 'bad device')
    assertIncludes(await outputText(page, 2), 'LabError: The model failed: the session ran out of memory', 'failing model')
    assertIncludes(await outputText(page, 3), 'LabError: Could not load stub/x: Unsupported pipeline: no-such-task', 'unknown task')
    assertIncludes(await outputText(page, 4), 'TypeError: lab cannot send a value of type object to JavaScript', 'unsupported value')
    assertIncludes(await outputText(page, 5), "TypeError: 'coroutine' object is not subscriptable", 'forgotten await')
    assertIncludes(await outputText(page, 5), 'Hint: functions that wait for the browser', 'the hint about await')
    assertIncludes(await outputText(page, 6), 'caught: LabError', 'errors can be caught as lab.LabError')
    await context.close()
  })

  suite.test('lab.tokenizer and next-token probabilities', async () => {
    const { context, page } = await fresh()
    await openNotebook(
      page,
      notebook([
        `import math, lab
lab.sync_calls(False)
tok = await lab.tokenizer("stub/gpt")
print(repr(tok))
ids = tok.encode("the cat sat on a mat.")
assert tok.tokens("the cat sat on a mat.") == ["the", "Ġcat", "Ġsat", "Ġon", "Ġa", "Ġmat", "."], tok.tokens("the cat sat on a mat.")
assert all(isinstance(i, int) for i in ids) and len(ids) == 7
assert tok.decode(ids) == "the cat sat on a mat.", tok.decode(ids)
assert tok.decode(ids[1]) == " cat"
assert (await lab.tokenizer("stub/gpt"))._id == tok._id          # cached`,
        `logits = await lab.next_token_logits("stub/gpt", " the cat sat")      # 3 tokens
# The stub's rule: logit of token v is v / 2, plus 3 for v == number of tokens % 8.
expected = [v / 2 + (3 if v == 3 else 0) for v in range(8)]
assert logits == expected, logits
total = sum(math.exp(x) for x in expected)
probs = await lab.next_token_probs("stub/gpt", " the cat sat", top_k=3)
assert [token for token, _ in probs] == [" on", " dog", " a"], probs
for (token, p), v in zip(probs, [3, 7, 6]):
    assert abs(p - math.exp(expected[v]) / total) < 1e-6, (token, p)
everything = await lab.next_token_probs("stub/gpt", " the cat sat", top_k=100)
assert len(everything) == 8 and abs(sum(p for _, p in everything) - 1) < 1e-9
assert all(isinstance(pair, tuple) for pair in everything)
print("probabilities ok")`,
        'await lab.next_token_probs("stub/gpt", "")',
      ]),
    )
    await runCell(page, 0)
    await runCell(page, 1)
    await runCell(page, 2)
    assert(!(await hasError(page, 0)), `tokenizer cell: ${await outputText(page, 0)}`)
    assert(!(await hasError(page, 1)), `probabilities cell: ${await outputText(page, 1)}`)
    assertIncludes(await outputText(page, 0), '<lab.Tokenizer stub/gpt>', 'repr')
    assertIncludes(await outputText(page, 1), 'probabilities ok', 'probabilities')
    assertIncludes(await outputText(page, 2), 'ValueError: The text is empty after tokenization', 'empty text')
    const log = await workerLog(page, '__stubLog')
    assertEqual(log.tokenizers.length, 1, 'the tokenizer was loaded once')
    assertEqual(log.models.length, 1, 'the language model was loaded once')
    await context.close()
  })

  suite.test('with JSPI the same calls work without await, and still with await', async () => {
    const { context, page } = await fresh()
    await openNotebook(
      page,
      notebook([
        'import lab\nfrom pyodide.ffi import can_run_sync\nprint("jspi:", can_run_sync(), lab.sync_calls())',
        `gen = lab.pipeline("text-generation", "stub/gpt")                 # no await
out = gen("Sync", max_new_tokens=2)                                 # no await
assert out == [{"generated_text": "Sync and so on (max_new_tokens=2)"}], out
assert isinstance(out, list)
def inside_a_function(prompt):
    return gen(prompt)[0]["generated_text"]
assert inside_a_function("Deep").startswith("Deep and so on")
tok = lab.tokenizer("stub/gpt")
assert tok.decode(tok.encode(" the cat")) == " the cat"
probs = lab.next_token_probs("stub/gpt", " the cat sat", top_k=2)
assert probs[0][0] == " on"
print("sync ok")`,
        `gen2 = await lab.pipeline("text-generation", "stub/gpt")          # await still works
out2 = await gen2("Async")
assert out2[0]["generated_text"].startswith("Async and so on") and gen2._id == gen._id
print("await ok")`,
        `lab.sync_calls(False)
import inspect
pending = gen("Off")
assert inspect.iscoroutine(pending)
assert (await pending)[0]["generated_text"].startswith("Off and so on")
assert lab.sync_calls() is False
lab.sync_calls(True)
print("switch ok")`,
      ]),
    )
    await runCell(page, 0)
    const first = await outputText(page, 0)
    if (!first.includes('jspi: True True')) {
      console.log(`        (this browser has no JSPI: ${first.trim()}; the synchronous path was not exercised)`)
      await context.close()
      return
    }
    for (const i of [1, 2, 3]) {
      await runCell(page, i)
      assert(!(await hasError(page, i)), `cell ${i}: ${await outputText(page, i)}`)
    }
    assertIncludes(await outputText(page, 1), 'sync ok', 'calls without await')
    assertIncludes(await outputText(page, 2), 'await ok', 'calls with await')
    assertIncludes(await outputText(page, 3), 'switch ok', 'lab.sync_calls(False) gives awaitables')
    await context.close()
  })

  suite.test('audio: lab.load_audio decodes and resamples on the page (bytes and address)', async () => {
    const { context, page } = await fresh()
    await openNotebook(
      page,
      notebook([
        `import math, lab
from lab import _media
lab.sync_calls(False)
tone = [0.5 * math.sin(2 * math.pi * 440 * i / 8000) for i in range(8000)]     # one second at 8 kHz
wav = _media.wav_bytes(tone, 8000)
samples, sr = await lab.load_audio(wav)                                         # default: 16 kHz
assert sr == 16000 and abs(len(samples) - 16000) <= 2, (sr, len(samples))
peak = max(abs(x) for x in samples)
assert 0.45 < peak < 0.55, peak
# 440 Hz for one second crosses zero about 880 times.
crossings = sum(1 for a, b in zip(samples, samples[1:]) if (a < 0) != (b < 0))
assert 860 <= crossings <= 900, crossings
same, sr8 = await lab.load_audio(wav, sr=8000)
assert sr8 == 8000 and len(same) == 8000
print("bytes ok")`,
        `from_url, sr = await lab.load_audio("${env.url}/test-tone.wav")
assert sr == 16000 and abs(len(from_url) - 8000) <= 2, len(from_url)            # half a second
print("address ok")`,
        'await lab.load_audio(b"this is not audio")',
        `await lab.load_audio("${env.url}/missing.wav")`,
      ]),
    )
    for (let i = 0; i < 4; i++) await runCell(page, i)
    assertIncludes(await outputText(page, 0), 'bytes ok', `decoding bytes: ${await outputText(page, 0)}`)
    assertIncludes(await outputText(page, 1), 'address ok', `decoding from an address: ${await outputText(page, 1)}`)
    assertIncludes(await outputText(page, 2), 'LabError: The browser could not decode this audio', 'undecodable audio')
    assertIncludes(await outputText(page, 3), 'the server answered 404', 'missing file')
    await context.close()
  })

  suite.test('lab.record: asks first, records from the (fake) microphone, can be cancelled', async () => {
    const { context, page } = await fresh({ permissions: ['microphone'] }, env.micBrowser)
    await openNotebook(
      page,
      notebook([
        `import lab
lab.sync_calls(False)
samples, sr = await lab.record(1)
assert sr == 16000
assert 0.6 * 16000 < len(samples) < 1.6 * 16000, len(samples)
print("recorded", len(samples), "peak", round(max(abs(x) for x in samples), 3))`,
        'await lab.record(1)',
        'await lab.record(0)',
      ]),
    )
    await cell(page, 0).locator('.run-button').click()
    const dialog = page.locator('dialog[open]')
    await dialog.waitFor()
    assertIncludes(await dialog.innerText(), 'asks to record 1 second from your microphone', 'the dialog says what will happen')
    assert(await cell(page, 0).evaluate((node) => node.classList.contains('is-running')), 'nothing is recorded before the button is pressed')
    await dialog.getByRole('button', { name: 'Start recording' }).click()
    await waitIdle(page)
    const text = await outputText(page, 0)
    assert(!(await hasError(page, 0)), `recording: ${text}`)
    assertIncludes(text, 'recorded', 'a recording came back')
    assert(Number(text.match(/peak ([\d.]+)/)[1]) > 0.01, `the fake microphone's beep is in the samples (${text.trim()})`)
    await cell(page, 1).locator('.run-button').click()
    await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click()
    await waitIdle(page)
    assertIncludes(await outputText(page, 1), 'LabError: The recording was cancelled.', 'cancel')
    await runCell(page, 2)
    assertIncludes(await outputText(page, 2), 'ValueError: lab.record can record between 0 and 60 seconds', 'bad duration')
    await context.close()
  })

  suite.test('lab.record: a refused microphone gives PermissionError', async () => {
    // Headless Chromium cannot show the permission prompt, so the refusal is simulated: the
    // browser's getUserMedia rejects exactly as it does when the student presses "Block".
    const { context, page } = await fresh()
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
    })
    await openNotebook(
      page,
      notebook(['import lab\nlab.sync_calls(False)\ntry:\n    await lab.record(1)\nexcept PermissionError as err:\n    print("caught PermissionError")\n    raise']),
    )
    await cell(page, 0).locator('.run-button').click()
    await page.locator('dialog[open]').getByRole('button', { name: 'Start recording' }).click()
    await waitIdle(page)
    const text = await outputText(page, 0)
    assertIncludes(text, 'caught PermissionError', 'the Python exception type')
    assertIncludes(text, 'PermissionError: The microphone was refused. Allow the microphone for this site', 'a clear error')
    assertExcludes(text, 'site-packages/lab', 'no frames of the lab package in the traceback')
    assertEqual(await page.locator('dialog[open]').count(), 0, 'the dialog is closed')
    await context.close()
  })

  suite.test('Hugging Face token: never in Python, outputs, autosave or the downloaded file', async () => {
    const { context, page } = await fresh()
    await openNotebook(
      page,
      notebook([
        `import lab
lab.sync_calls(False)
status = lab.hf_token()
assert not status and repr(status) == "<Hugging Face token: not set>"
await lab.inference.chat("stub/chat", "hello")`,
        `status = lab.hf_token()
assert status, "set the token with the button first"
print(status)
reply = await lab.inference.chat("stub/chat", "hello there", max_tokens=20, temperature=0.5)
print("reply:", reply)
full = await lab.inference.chat("stub/chat", [{"role": "system", "content": "be brief"}, {"role": "user", "content": "hi"}], full=True)
print("usage:", full["usage"]["total_tokens"], full["choices"][0]["message"]["content"])`,
        'await lab.inference.chat("stub/fail", "x")',
        `image = await lab.inference.text_to_image("stub/draw", "a red dot", width=64, seed=1)
print(repr(image), len(image.data))
image`,
        `import array
result = await lab.inference.asr("stub/asr", array.array("f", [0.0] * 1600), sr=16000)
print(result)`,
        'await lab.inference.chat("stub/chat", "x", endpointUrl="https://evil.example")',
        'await lab.inference.chat("https://evil.example/v1", "x")',
        `import js
# The worker that runs this code has no access to the page's storage, where the token lives.
print("localStorage" in dir(js), "document" in dir(js))
# A student pastes the token into a cell by mistake:
pasted = "${TOKEN}"
print("pasted:", pasted)
lab.html("<p>token in html: " + pasted + "</p>")
pasted`,
        'raise RuntimeError("error with ' + TOKEN + ' inside")',
        'again = await lab.set_hf_token()\nprint("after dialog:", again)',
      ]),
      'token.ipynb',
    )
    // Without a token: a clear error, and the client is never created.
    await runCell(page, 0)
    assertIncludes(await outputText(page, 0), 'LabError: No Hugging Face token is set', 'no token')
    assertIncludes(await outputText(page, 0), 'HF token', 'the message says where to set it')
    assertEqual(await page.evaluate(() => globalThis.__inferenceLog ?? null), null, 'no request was attempted without a token')

    // Set the token with the toolbar button.
    await page.getByRole('button', { name: 'HF token' }).click()
    const dialog = page.locator('dialog[open]')
    await dialog.locator('input').fill('not a token')
    await dialog.getByRole('button', { name: 'Save' }).click()
    assertIncludes(await dialog.locator('.dialog-error').innerText(), 'does not look like a Hugging Face token', 'bad input is refused')
    assertEqual(await dialog.locator('input').getAttribute('type'), 'password', 'the token field hides its text')
    await dialog.locator('input').fill(TOKEN)
    await dialog.getByRole('button', { name: 'Save' }).click()
    await page.getByRole('button', { name: 'HF token: set' }).waitFor()

    for (let i = 1; i <= 8; i++) await runCell(page, i)
    const texts = []
    for (let i = 0; i <= 8; i++) texts.push(await outputText(page, i))
    assertIncludes(texts[1], '<Hugging Face token: set, kept in this browser only>', 'status after setting')
    assertIncludes(texts[1], 'reply: You said: hello there (my token is [hidden: Hugging Face token])', 'the reply arrives, the echoed token is hidden')
    assertIncludes(texts[1], 'usage: 8 You said: hi', 'full=True returns the whole response')
    assertIncludes(texts[2], 'LabError: The request to Hugging Face failed: 401 Unauthorized: invalid token [hidden: Hugging Face token]', 'errors hide the token')
    assertIncludes(texts[3], '<lab.Image image/png, 70 bytes> 70', 'text_to_image returns a lab.Image')
    assertEqual(await cell(page, 3).locator('.cell-outputs img').evaluate((node) => node.naturalWidth), 1, 'the image is shown')
    assertIncludes(texts[4], "{'text': 'transcript of 3244 bytes'}", 'asr sends a WAV file (44 byte header + 1600 samples of 16 bit)')
    assertIncludes(texts[5], 'TypeError: lab.inference.chat does not take endpointUrl', 'unknown options are refused')
    assertIncludes(texts[6], 'ValueError: model must be a Hugging Face model id', 'an address is not a model id')
    assertIncludes(texts[7], 'False False', 'notebook code cannot reach the page or its storage')
    for (const [i, text] of texts.entries()) assertExcludes(text, TOKEN, `the token is not visible in the output of cell ${i}`)
    const rendered = await page.evaluate(() => Array.from(document.querySelectorAll('.cell-outputs'), (node) => node.innerHTML).join('\n'))
    assertExcludes(rendered, 'TESTtoken0123456789', 'the token is nowhere in the rendered outputs')
    assertIncludes(texts[7], 'pasted: [hidden: Hugging Face token]', 'a printed token is hidden')
    assertIncludes(texts[8], 'error with [hidden: Hugging Face token] inside', 'a token in a traceback is hidden')

    // What the client was given: fixed option names only.
    const log = await page.evaluate(() => globalThis.__inferenceLog)
    assert(log.filter((entry) => entry.call === 'new').every((entry) => entry.tokenLooksRight), 'the client got the token')
    const chat = log.find((entry) => entry.call === 'chatCompletion')
    assertEqual(chat.keys, ['max_tokens', 'messages', 'model', 'temperature'], 'chat arguments')
    const draw = log.find((entry) => entry.call === 'textToImage')
    assertEqual([draw.inputs, draw.parameters, draw.options], ['a red dot', { width: 64, seed: 1 }, { outputType: 'blob' }], 'image arguments')
    const asr = log.find((entry) => entry.call === 'automaticSpeechRecognition')
    assertEqual([asr.keys, asr.type], [['data', 'model'], 'audio/wav'], 'asr arguments')
    assert(!log.some((entry) => entry.model === 'https://evil.example/v1'), 'the address never reached the client')

    // The worker never received the token.
    const inWorker = await page.workers()[0].evaluate((token) => {
      const seen = []
      for (const key of Object.getOwnPropertyNames(globalThis)) {
        try {
          if (typeof globalThis[key] === 'string' && globalThis[key].includes(token)) seen.push(key)
        } catch {
          // Some globals throw on access.
        }
      }
      return seen
    }, TOKEN)
    assertEqual(inWorker, [], 'no global of the worker holds the token')

    // Autosave and download.
    await waitSaved(page)
    const stored = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('notebook-lab:doc:')).map(([, value]) => value).join('\n'))
    assertExcludes(stored, TOKEN, 'the autosaved notebook does not contain the token')
    assertIncludes(stored, '[hidden: Hugging Face token]', 'the pasted token was replaced in the autosave')
    const saved = await download(page)
    assertExcludes(saved.text, TOKEN, 'the downloaded file does not contain the token')
    assertExcludes(saved.text, 'TESTtoken0123456789', 'not even a part of it')
    assertIncludes(saved.text, 'pasted = \\"[hidden: Hugging Face token]\\"', 'a token pasted into a cell is replaced in the file')
    JSON.parse(saved.text)
    assertEqual(await page.evaluate(() => localStorage.getItem('notebook-lab:hf-token')), TOKEN, 'the token itself is in this browser\'s storage only')

    // lab.set_hf_token() opens the same dialog; removing the token there is seen by Python.
    await cell(page, 9).locator('.run-button').click()
    const second = page.locator('dialog[open]')
    await second.waitFor()
    await second.getByRole('button', { name: 'Remove token' }).click()
    await waitIdle(page)
    assertIncludes(await outputText(page, 9), 'after dialog: <Hugging Face token: not set>', 'the status after removing')
    assertEqual(await page.evaluate(() => localStorage.getItem('notebook-lab:hf-token')), null, 'the token is removed from storage')
    await page.getByRole('button', { name: 'HF token', exact: true }).waitFor()
    await runCell(page, 1)
    assertIncludes(await outputText(page, 1), 'AssertionError: set the token with the button first', 'Python sees that the token is gone')
    await context.close()
  })
}
