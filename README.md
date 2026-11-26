# Notebook Lab: course notebooks that run in the student's browser

**Status: prototype.** This repository tests one idea for a university NLP/AI course (speech to text, text to speech, language models, the transformer, diffusion): hand out assignments as ordinary `.ipynb` notebooks that run **entirely in the student's browser**. Python runs in the tab, models run on the student's own graphics card, and a server would only ever have to store files.

The prototype exists to prove the risky technical parts. It is not the product: there are no accounts, no server and no grading backend.

## What it is

A static single-page app:

- **A notebook page.** Code cells (CodeMirror 6, Python highlighting) and Markdown cells (with formulas). Run a cell with Shift+Enter or Ctrl+Enter, run all, add, delete, move and convert cells, clear outputs, restart. Outputs stream while a cell runs: text, errors with tracebacks, the value of the last line, HTML, images, audio players, tables.
- **Real `.ipynb` files.** Open one from disk (button or drag and drop), download it again as nbformat 4.5. Cell ids, tags, unknown metadata, attachments and outputs survive the round trip, so the files open in Jupyter and Colab.
- **Python in a Web Worker** (Pyodide). A long computation never freezes the page; "Restart" terminates the worker and starts a new one. Packages that ship with Pyodide (NumPy, matplotlib, micropip, ...) are downloaded when a cell first imports them.
- **`lab`**, a small Python package that connects notebooks to what only the browser can do: models on the graphics card through Transformers.js, audio decoding and recording, rich outputs, and models hosted by Hugging Face with the student's own token.
- **Check cells**, a first taste of autograding: a code cell with the tag `check` shows *Check passed* or *Check failed* after it runs, and the page counts them.
- **Six sample notebooks**, listed in the menu at the top left.
- **Autosave** in the browser's localStorage, one copy per sample notebook, with a visible state ("Saving…", "Saved in this browser").

Notebooks are treated as untrusted input: rendered Markdown and every HTML or SVG output go through a sanitizer (DOMPurify), and the site ships a Content-Security-Policy without inline scripts.

## Run it locally

Needs Node 22 or newer, and Python 3 with NumPy for one part of the tests.

```sh
npm install
npm run dev          # http://localhost:5173, loads Pyodide and the model libraries from the jsDelivr CDN
```

```sh
npm run typecheck
npm test             # vitest (unit tests, and lab against real Pyodide in Node) + the notebooks under CPython
npm run test:e2e     # the app in Chromium; needs Playwright, see tests/e2e/helpers.mjs
npm run build        # the site, in dist/
npx wrangler dev     # serves dist/ like Cloudflare does, with the headers of public/_headers
npm run deploy       # build and deploy to Cloudflare Workers static assets (wrangler.jsonc)
```

Without internet access, `npx vite --mode e2e` starts the dev server with Pyodide from `node_modules` and stand-ins for the model libraries.

`npm run test:e2e` builds a second bundle (`dist-e2e/`) that needs no internet: Pyodide is copied from the `pyodide` npm package and the model libraries are replaced by small stand-ins (`tests/stubs/`). Which address each part loads from is decided in one file, `src/config.ts`, and can be overridden at build time with the `VITE_*` variables shown in `.env.e2e`.

## How it is built

```
 Page (main thread)                                Web Worker "python"
 ────────────────────────────────                  ─────────────────────────────────────────────
 src/app.ts        toolbar, cells, autosave        src/runtime/worker.ts   starts Pyodide, runs cells
 src/ui/*          editor, outputs, dialogs   ◄──► python/lab/*.py         the lab package (Python)
 src/notebook/*    .ipynb, Markdown, sanitizer     src/runtime/bridge.ts   lab's JavaScript side:
 src/runtime/client.ts   starts/stops the worker                           Transformers.js, tokenizers,
 src/runtime/host.ts     page-only services:                               conversion, progress
   · decode audio, record from the microphone
   · the token dialog
   · requests to Hugging Face (with the token)
```

Messages between the two sides are listed in `src/runtime/protocol.ts`.

What loads from where:

| What | From | Pinned version |
|---|---|---|
| The app (HTML, CSS, JS, the six notebooks, the `lab` sources, formula fonts) | this site | |
| Pyodide (Python 3.14 as WebAssembly) and its packages (NumPy, ...) | `cdn.jsdelivr.net/pyodide/` | 314.0.8 |
| Transformers.js (`@huggingface/transformers`), imported inside the worker on first use | `cdn.jsdelivr.net/npm/` | 4.3.2 |
| The Hugging Face client (`@huggingface/inference`), imported by the page on first use | `cdn.jsdelivr.net/npm/` | 4.13.33 |
| Model files | `huggingface.co` (cached by the browser) | set in each notebook |

Bundled with the app (npm): CodeMirror 6, `marked`, DOMPurify, KaTeX. Development only: Vite, TypeScript, vitest, jsdom, wrangler, and `pyodide` 314.0.8 (the exact version production loads from the CDN, used by the tests).

### How Python and JavaScript talk

- The worker registers the JavaScript bridge as the Python module `_lab_js`. Python calls `_lab_js.call(method, json, buffers)` and gets a promise; JavaScript answers with `{ json, buffers }`.
- A value crosses as **one JSON string plus a list of typed arrays**. Inside the JSON, an array is a placeholder (`{"__nd__": 0, "dtype": "float32", "shape": [2, 3]}`); on the Python side it becomes a NumPy array, on the JavaScript side a typed array or a Transformers.js tensor. Tensors, audio (`{audio, sampling_rate}`) and images coming back from a model are converted the same way. This keeps the border simple: no proxy objects to free, plain Python data on the Python side.
- JavaScript errors arrive in Python as ordinary exceptions (`lab.LabError`, `ValueError`, `PermissionError`, ...) with tracebacks that start in the student's cell.
- **With or without `await`.** Functions that wait for the browser are coroutines: `result = await pipe(audio)`. In browsers with JavaScript Promise Integration (JSPI; `pyodide.ffi.can_run_sync()` is true) the same functions wait by themselves, so `result = pipe(audio)` also works, including inside an ordinary `def`. A result returned that way can still be awaited, so a notebook written with `await` runs everywhere. `lab.sync_calls()` reports which mode is active; `lab.sync_calls(False)` switches the automatic waiting off.
- **The token never reaches notebook code.** The student's Hugging Face token is typed into a dialog of the page and kept in that browser's localStorage. Requests to Hugging Face are made by the page (`src/runtime/host.ts`), not by the worker, with a fixed list of option names. Python only learns *whether* a token is set. If the token appears in an output or is pasted into a cell, it is replaced by `[hidden: Hugging Face token]` on screen, in the autosave and in the downloaded file. (The brief asked for the client "in the worker"; it runs on the page instead so that the code of an untrusted notebook cannot read the token.)

## The `lab` package

```python
import lab

lab.device()                      # dict: webgpu, adapter, browser, cross_origin_isolated, cpu_threads, jspi, ...
```

**Models in this browser** (Transformers.js; `device="auto"` uses WebGPU when there is an adapter, else the CPU; if loading on the graphics card fails, it retries on the CPU and says so):

```python
asr = await lab.pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en")   # device="auto", dtype=None
print(asr.device, asr.size_mb, asr.load_seconds)
result = await asr(audio, return_timestamps=True)        # keyword arguments are the pipeline's options
result["text"], result["chunks"]

tok = await lab.tokenizer("Xenova/distilgpt2")
ids = tok.encode("Hello world")                           # these three answer at once, no await
tok.tokens("Hello world"), tok.decode(ids)

await lab.next_token_probs("Xenova/distilgpt2", "The capital of France is", top_k=10)   # [(token, probability), ...]
await lab.next_token_logits("Xenova/distilgpt2", "The capital of France is")            # NumPy array, one entry per token
```

Loaded pipelines are cached per task, model, device and dtype. Download progress appears in the status line. `next_token_probs` and `next_token_logits` are **experimental**: they are written against `AutoModelForCausalLM` of Transformers.js and tested only with a stand-in, not with a real model.

**Sound and pictures**

```python
audio, sr = await lab.load_audio("https://.../speech.wav")   # or bytes; mono float32, resampled to sr=16000
audio, sr = await lab.record(5)                               # asks first; PermissionError if the microphone is refused
lab.play(audio, sr)                                           # an audio player
lab.show(array_or_image_bytes)                                # (h, w), (h, w, 3) or (h, w, 4); floats 0..1 or integers 0..255
lab.html("<b>any HTML or SVG</b>")                            # sanitized by the page
lab.table([{"token": "the", "p": 0.5}])                       # list of dicts, list of lists, or a 2-D array
display(value)                                                # as the last line of a cell would show it
```

**Hosted models** (the student's own token: the "HF token" button, or `await lab.set_hf_token()`)

```python
if lab.hf_token():                                            # true-ish when a token is set; never the token itself
    text = await lab.inference.chat("meta-llama/Llama-3.1-8B-Instruct", "Explain attention in one sentence.", max_tokens=80)
    image = await lab.inference.text_to_image("black-forest-labs/FLUX.1-schnell", "two moons")   # a lab.Image
    result = await lab.inference.asr("openai/whisper-large-v3", audio)                           # {"text": ...}
```

Without a token these raise `lab.LabError` with a message that says where to set it.

## The six notebooks

In `notebooks/`. Each states roughly how large its download is and has its model id in a variable in the first code cell.

| Notebook | What it does | Downloads |
|---|---|---|
| `00-check-your-setup` | Python, NumPy, `lab.device()`, a 2 × 2 linear system, a first check cell, a picture | NumPy |
| `01-speech-to-text` | Whisper tiny on a sample recording and on the student's voice; timestamps; **exercise:** word error rate, with a check | `Xenova/whisper-tiny.en`, roughly 40 to 150 MB |
| `02-text-to-speech` | SpeechT5 with a speaker embedding; play the result; waveform drawing; sanity check of the speaking rate | `Xenova/speecht5_tts`, a few hundred MB |
| `03-llm-tokens-and-sampling` | Tokens, next-token probabilities; **exercises:** softmax with temperature and top-k sampling over real logits, with checks; generation; optional hosted chat | `Xenova/distilgpt2`, roughly 80 to 330 MB |
| `04-attention-from-scratch` | Scaled dot-product attention, causal mask, multi-head attention in NumPy, shapes explained, four check cells | NumPy |
| `05-diffusion-toy` | A DDPM on 2-D points in pure NumPy: forward process, an MLP with hand-written backpropagation and a gradient check, Adam, sampling, SVG scatter plots; optional hosted text-to-image | NumPy |

The download sizes are estimates from the models' parameter counts, not measurements; the notebooks print the real size after loading. Notebook 05 trains 4000 steps in about 2.7 s under CPython on the machine that built this prototype; in the browser expect it to be a few times slower (not measured).

Notebooks 01 and 03 are handed out with the exercise unsolved, so their exercise checks fail until the student completes the function. Reference solutions are in `tests/python/solutions.py`.

## Test checklist for a real laptop

None of the model paths could be run where this prototype was built (no graphics card, no access to the CDNs or to Hugging Face). Please run this once in **Chrome or Edge** on a laptop with a graphics card, and once more on a machine without one if you can.

Before you start: `npm install && npm run dev`, open the page, open DevTools (F12) on the Console tab, and note the browser version and the graphics card (`chrome://gpu`, or the output of notebook 00).

| # | Do | Expect | Note down |
|---|---|---|---|
| 1 | Open the page. Run the first cell of **00**. | Status line: "Loading Python (Pyodide)…", then "Idle · Python 3.14… · graphics card available (WebGPU)". Output `Running in: emscripten`. | Seconds until the first output. Any red line in the console. |
| 2 | **00**, Run all. | NumPy loads ("Loading package numpy…"), `lab.device()` lists `webgpu: True` and an adapter, the check says *Check passed*, a grey picture with a circle appears. | The `adapter` line; `jspi`; `cross_origin_isolated` (should be False). |
| 3 | **04**, Run all. | Four checks pass, three attention pictures. | Seconds for the whole notebook. |
| 4 | **05**, Run all. | The loss settles near 0.7 (it starts near 2); "trained 4000 steps in … s"; scatter plots show two moons emerging from noise; three checks pass. | The training time it prints. |
| 5 | **01**, run the cells down to the timestamp table. | Audio player with the Kennedy recording (11 s). Model loads with progress in the status line. Text: "And so my fellow Americans, ask not what your country can do for you…". A table with timestamps. | The printed `model files: … MB, loaded in … s, running on …`; the real-time factor; whether it ran on `webgpu` or fell back (a line starting with "lab: … did not load on the graphics card"). |
| 6 | **01**, complete `word_error_rate` (or paste the solution from `tests/python/solutions.py`), run the check and the two cells after it. | *Check passed*; WER 0.0 or close. | |
| 7 | **01**, run the recording cell, press "Start recording", speak. | The browser asks for the microphone; the dialog counts down; a player with your voice; a transcript. Then press Cancel on a second try: `lab.LabError: The recording was cancelled.` Block the microphone in the address bar and try again: `PermissionError`. | Whether the recording sounds right (not too fast or slow). |
| 8 | **02**, Run all. | A voice says the sentence; the waveform drawing shows bursts; the check passes. | Size, load time, device, real-time factor. Does `DTYPE = "q8"` still sound acceptable? If WebGPU fails here, the fallback message. |
| 9 | **03**, run down to the logits cell. | A token table; ten likely next tokens (" Paris" should be near the top); `shape: (50257,)`. | Size, load time. **This is the least certain part** (`next_token_logits`). If it fails, copy the error. |
| 10 | **03**, paste the two solutions, run the rest. | Both checks pass; three generated continuations; the built-in generator prints text. | Seconds per generated token (each step re-runs the model). |
| 11 | Press **HF token**, paste a token, run the last code cell of **03** and of **05**. | A two-sentence answer; a generated picture. | Whether the model ids still exist with an inference provider; any error text. Then Download the notebook and search the file for your token: it must not be there. |
| 12 | In any notebook: write `x = pipe_or_any_lab_call(...)` **without** `await` (for example `tok = lab.tokenizer("Xenova/distilgpt2")`). | With JSPI (`lab.sync_calls()` is True) it works. | |
| 13 | Run a cell with `while True: pass`, then press **Restart**. | The page stays responsive; the cell ends with "The runtime was restarted…". | |
| 14 | Download a notebook with outputs and open it in Jupyter or upload it to Colab. | It opens; text, images and the audio player show (Colab may ask to trust HTML outputs). | Anything that looks different. |
| 15 | `npm run build && npx wrangler dev`, repeat steps 2 and 5 at the address it prints. | The same results under the site's Content-Security-Policy. | Console lines that start with "Refused to …": they name what `public/_headers` must allow. |
| 16 | Open the page on a phone. | Notebooks are readable, nothing scrolls sideways. Running models there is not a goal. | |

### What was verified here, and what was not

| | Verified in this environment | Not verified |
|---|---|---|
| Notebook engine | In Chromium with real Pyodide 314.0.8 (served from the npm package): running cells, streaming, errors, top-level await, restart (also of an endless loop), keyboard, open/download round trip, drag and drop, check cells, autosave (also with full storage), 1280 and 390 px, light and dark, no console errors | Other browsers (Firefox, Safari); Pyodide loaded from the CDN |
| Security | Malicious Markdown, stored HTML/SVG outputs and `lab.html`: nothing runs. The page runs under the Content-Security-Policy of `public/_headers`, including Pyodide | The policy with the real CDN libraries (the ONNX runtime may need something more) |
| NumPy | The NumPy notebooks (00, 04, 05) and the NumPy code of 01 to 03 run under CPython 3.13 with NumPy 2.5; the NumPy side of the converter and of `lab.show`/`lab.play` is tested there | **NumPy inside Pyodide in the browser** (the package cannot be downloaded here; the failure message was tested instead) |
| `lab` bridge | Against stand-ins with the same shapes as Transformers.js: conversion both ways, tensors, audio, images, caching, progress in the status line, CPU fallback, error messages; in the browser and in Node | **Real model downloads; WebGPU execution; the exact model ids;** real output formats of every pipeline |
| Tokens and probabilities | Tokenizer calls and the softmax/top-k of `next_token_probs` against a stand-in model with known logits | `AutoModelForCausalLM` with a real ONNX model (experimental) |
| Calls without `await` | JSPI was available in the test Chromium: `lab` calls work with and without `await` against the stand-ins | The same with real, long-running model calls |
| Audio | Decoding and resampling a WAV file on the page; recording from Chromium's fake microphone through the dialog; cancel; a simulated refusal | A real microphone and the real permission prompt; mp3/ogg/flac files; the Hugging Face sample file |
| Hosted models | The page-side client against a stand-in: arguments, missing token, the token never in Python, outputs, autosave or the file | **The real Inference API**, the model ids, provider routing, error texts |
| Deploy | `npm run build`; `wrangler deploy --dry-run` | A real deployment |
| CI | The commands of `.github/workflows/ci.yml`, run by hand | The workflow on GitHub |

## Known limits

- **No PyTorch, TensorFlow or JAX.** Pyodide has NumPy, SciPy, scikit-learn, pandas, matplotlib and pure-Python packages. Models run through Transformers.js (ONNX), for inference only.
- **No training of real models.** Training in NumPy on the CPU is fine for toy problems (notebook 05). Fine-tuning a transformer is not possible here.
- **Hardware decides.** WebGPU needs a recent Chrome or Edge (and a supported graphics card); elsewhere models run on the CPU in a single thread and are much slower. Models must fit into the memory of the tab: small models (tens to a few hundred MB) are realistic, multi-gigabyte ones are not. Every student downloads every model once.
- **Checks in the browser can be tampered with.** A student can edit a check cell, remove the tag or edit the file. Check cells are feedback, not proof. Grades need a run on a machine the student does not control.
- **Stopping a cell means restarting.** Without cross-origin isolation there is no way to interrupt Python, so the only stop is "Restart", which also forgets the variables and the loaded models (the files stay cached).
- **Cross-origin isolation is off.** The site does not send COOP/COEP headers. Turning them on would give the CPU fallback several threads (noticeably faster on machines without WebGPU), but then every cross-origin file must be served in a compatible way. That has to be tested with jsDelivr and Hugging Face first.
- **Storage.** Autosave uses localStorage (about 5 MB per site). Large outputs (audio, images) can exceed it; then the notebook is saved without outputs and the page says so. One slot per sample notebook and one for the last opened file.
- **matplotlib** figures are shown after a cell on a best-effort basis that has not been tested; the samples draw with `lab.show` and SVG instead.
- **Hugging Face tokens** in localStorage are readable by any script on the same origin. The sanitizer and the Content-Security-Policy are there to keep foreign scripts out; a token with only the "inference providers" permission limits the damage.
- No analytics, no cookies.

## Next steps toward the product

1. **Run the checklist above** and fix what it finds: model ids, dtype defaults per device, the Content-Security-Policy, `next_token_logits`.
2. **Accounts and storage:** sign-in for students and instructors; notebooks and submissions stored on the server instead of localStorage (the server still runs no student code).
3. **Assignments:** an instructor publishes a notebook as an assignment with a deadline; students get their own copy; autosave to the server; hand-in freezes a version.
4. **Instructor view:** who started, who handed in, check results per student, open any submission read-only, comments.
5. **Grading that can be trusted:** read nbgrader's metadata (`grade`, `solution`, `locked`, `points`) in addition to the `check` tag, lock test cells in the student view, keep hidden tests out of the student's copy, and re-run submissions in a controlled runtime (for NumPy-only work, the same notebooks run under ordinary CPython, as the tests here do).
6. **Hand-off to Colab** for assignments that need PyTorch or a real GPU: an "Open in Colab" action for the same `.ipynb`, with a `lab` package for Colab that offers the same calls on top of `transformers`.
7. **Runtime work:** interrupt instead of restart and multi-threaded CPU fallback (both need cross-origin isolation), a model cache page (what is downloaded, how large, delete), streaming text generation, self-hosting Pyodide and the libraries so that a class does not depend on a CDN, tests in Firefox and Safari.

## Repository layout

```
index.html, src/          the app (TypeScript)
python/lab/               the lab package (Python, bundled into the worker)
notebooks/                the six sample notebooks
public/_headers           security headers for Cloudflare
wrangler.jsonc            Cloudflare Workers static assets
tests/unit/               vitest: lab against Pyodide in Node, project checks (more tests sit next to the code in src/)
tests/python/             the notebooks and the lab package under CPython
tests/e2e/                the app in Chromium (Playwright)
tests/stubs/              stand-ins for Transformers.js and the Hugging Face client
```
