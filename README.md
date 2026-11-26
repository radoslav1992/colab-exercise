# Notebook Lab: course notebooks that run in the student's browser

Notebook Lab is a site for a university NLP/AI course (speech to text, text to speech, language models, the transformer, diffusion). A teacher sets an assignment as an ordinary `.ipynb` notebook, students do it **in the browser** and submit, and the teacher sees and grades the submissions.

Python runs in the student's tab, models run on the student's own graphics card, and the server only stores data: accounts, courses, notebooks, submissions and grades. It never runs anybody's code.

**Status.** The notebook engine was the first stage (the "prototype"); this stage adds accounts, courses, assignments and submissions. Everything described here was tested where it was built, including the API on a local copy of the Cloudflare runtime, but the site has **not been deployed yet** and the model paths have **not been run on a real laptop** yet. Both lists are below: [deployment](#deployment-for-the-owner) and the [laptop checklist](#test-checklist-for-a-real-laptop).

## What it is

- **A notebook page.** Code cells (CodeMirror 6, Python highlighting) and Markdown cells (with formulas). Run a cell with Shift+Enter or Ctrl+Enter, run all, add, delete, move and convert cells, clear outputs, restart. Outputs stream while a cell runs: text, errors with tracebacks, the value of the last line, HTML, images, audio players, tables.
- **Real `.ipynb` files.** Open one from disk (button or drag and drop), download it again as nbformat 4.5. Cell ids, tags, unknown metadata, attachments and outputs survive the round trip, so the files open in Jupyter and Colab.
- **Python in a Web Worker** (Pyodide). A long computation never freezes the page; "Restart" terminates the worker and starts a new one.
- **`lab`**, a small Python package that connects notebooks to what only the browser can do: models on the graphics card through Transformers.js, audio decoding and recording, rich outputs, and models hosted by Hugging Face with the student's own token.
- **Check cells.** A code cell with the tag `check` shows *Check passed* or *Check failed* after it runs, and the page counts them.
- **The playground.** Without an account the site is the notebook page with six sample notebooks, saved in the browser only. This is all a visitor sees, and all there is on a deployment without a database.

With an account:

- **Accounts.** Email, password and name; a role chosen at sign-up (teacher or student) that only decides what the home page shows first. Sign in and out, change name and password, delete the account, reset a forgotten password. No email verification.
- **Courses.** A teacher creates a course and gets a join code (8 characters without look-alikes such as 0/O and 1/I/L). The code can be replaced and joining switched off. The teacher sees the roster (name, email, date joined), can remove a student, archive or delete the course. A student joins with the code and can leave. Anybody can teach some courses and be a student in others: what a person may do is decided per course, never by the role.
- **Assignments.** Made from a notebook: an uploaded `.ipynb`, a sample, the notebook open in the playground, or an empty one. Title, instructions (Markdown, sanitized), due date and time (stored as UTC, shown in local time), points. States: *draft* (invisible to students), *published*, *closed* (no more submissions; can be opened again). The starter can be edited in the normal editor before publishing; replacing it afterwards reaches only students who have not opened the assignment yet. Students only ever receive the starter.
- **Student work.** Opening an assignment makes the student's own copy. It is saved on the server while they type (with a visible state) and in the browser, so that work survives a closed tab and a lost connection. A second tab cannot silently overwrite newer work: the server refuses a save on top of an old version, and the student chooses "Keep mine" or "Load the newer one".
- **Submit.** Stores a snapshot with the server's time. Submitting again is allowed until the assignment is closed; the latest snapshot and the count are kept, and a submission after the due time is marked late. The page also reports how many check cells passed in the last run. That number is shown everywhere as *reported by the student's browser, not proof*: it can be faked.
- **Review.** A table of all enrolled students: status (not started, in progress, submitted, submitted late), submission time, reported checks, grade, feedback, and counts at the top. A submission opens in the notebook view with the outputs as submitted; the teacher can run and change cells, and nothing done there is saved or changes the submission. Grade (a number) and feedback (plain text or Markdown) per submission; students see them once the teacher releases the grades of the assignment. One submission downloads as `.ipynb`, all of them as one `.zip` built in the browser, the table as CSV.
- **Privacy page** at `/privacy`: what is stored, where, how long, how to delete it.

Notebooks are treated as untrusted input everywhere: rendered Markdown and every HTML or SVG output go through a sanitizer (DOMPurify), the site ships a Content-Security-Policy without inline scripts, and code in a notebook cannot use the session of whoever runs it ([security model](#security-model)).

## Run it locally

Needs Node 22.18 or newer (the server's TypeScript runs directly in Node), and Python 3 with NumPy for one part of the tests.

```sh
npm install
npm run dev          # the site on http://localhost:5173 and the API on :8787 (SQLite file in .data/)
```

`npm run dev` starts two things: the API (`server/dev.ts`, restarted when server code changes, password reset emails printed to the terminal) and Vite, which serves the site and passes `/api` on. The site loads Pyodide and the model libraries from the jsDelivr CDN; `npm run dev -- --mode e2e` uses Pyodide from `node_modules` and stand-ins for the model libraries instead, so it works without internet.

Other ways to run it:

```sh
npm run dev:web      # the site only: no API, so no accounts, the playground only
npm run start:local  # build, then the built site and the API on :8787, served the way Cloudflare serves them
npm run db:migrate:local && npm run dev:worker   # the real Worker with a local D1 database (wrangler dev, which builds the site first)
```

Checks:

```sh
npm run typecheck
npm test             # vitest: unit tests, the API against SQLite, lab against real Pyodide; then the notebooks under CPython
npm run test:e2e     # the app in Chromium; needs Playwright, see tests/e2e/helpers.mjs
npm run build        # the site, in dist/
npx wrangler deploy --dry-run   # bundles the Worker and lists the bindings; uploads nothing
```

`npm run test:e2e` builds a second bundle (`dist-e2e/`) that needs no internet. The notebook tests run against a Node server (the build folder served like Cloudflare serves it, plus the API on SQLite in memory). The tests of accounts and courses run against the real Worker under `wrangler dev` with a local D1 database, whose schema is applied by `wrangler d1 migrations apply`; if `wrangler dev` cannot start, they fall back to the Node server and say so. `E2E_SUITE=accounts` or `E2E_SUITE=notebooks` runs one half, `SCREENSHOT_DIR=…` saves screenshots.

## Deployment, for the owner

The D1 database exists already, with the schema applied and no data: `colab-exercise`, id `0bafc51f-2518-475e-ab08-c38c90cbfb94`, bound as `DB` in `wrangler.jsonc`. In this order:

1. **Fill in the two placeholders** in `wrangler.jsonc` under `vars`: `CONTROLLER_NAME` (who is responsible for the data: you, or the university) and `CONTROLLER_CONTACT` (an email address for questions about data). They appear on the privacy page and in the "forgot password" dialog. While they are empty the privacy page shows a marked "NOT SET" notice. Nothing in the repository invents them.
2. **Read the privacy text** (`src/legal.ts`, shown at `/privacy`) and change what does not fit your situation. It describes what the code does; whether it is sufficient for your university is your call.
3. **The schema is already applied** (26 November 2026): `migrations/0001_init.sql` is in the database and recorded in its `d1_migrations` table, so `npm run db:migrate:remote` (that is `wrangler d1 migrations apply colab-exercise --remote`) reports nothing to do. Later migrations are applied with that command, after `npx wrangler login`.
4. **Deploy:** `npm run deploy` (wrangler builds the site first). The deployment changes from "static files only" to "static files plus a Worker for `/api/*`", and creates the daily cron trigger.
5. **Check:** open the site: a "Sign in" button appears next to the theme button. Create a teacher account, a course and an assignment; in a private window create a student account, join with the code, submit. Then go through the [laptop checklist](#test-checklist-for-a-real-laptop).
6. **Password resets.** Without an email binding, "Forgot your password?" tells people to write to `CONTROLLER_CONTACT`. You then run `npm run reset-link -- their@address --base=https://<the site>` and send them the link it prints (it works once, for 24 hours; send it only to the address of the account).
7. **Optional: reset emails.** Needs a domain set up for Email Sending in the Cloudflare account. Then uncomment `send_email` in `wrangler.jsonc`, set `APP_URL` and `MAIL_FROM` under `vars`, and deploy again. This path has not been tested against the real email service.

Pull-request previews do not get the database (on purpose: a preview must never touch real accounts). There the API answers 503 and the page is the playground only, without a sign-in button.

Not known from here, to check once: whether your Workers plan's CPU limit is enough. Signing in hashes the password with PBKDF2 (100,000 iterations) and a save parses up to 1 MB of JSON; both are small, but the free plan allows only 10 ms of CPU per request. If sign-in or saving fails with a CPU error in the Worker logs, the Workers Paid plan is the fix.

## How it is built

```
 Browser                                                        Cloudflare
 ──────────────────────────────────────────────────────         ─────────────────────────────────
 Page (main thread)                 Web Worker "python"          static assets (dist/, _headers)
 src/app.ts      header, views      src/runtime/worker.ts        index.html, courses.html, ...
 src/views/*     notebook, course,    starts Pyodide,
                 assignment, ...      runs cells                 Worker (worker/index.ts): /api/*
 src/api.ts      talks to /api  ───────────────────────────────►   server/app.ts   the API (Hono)
 src/sync.ts     autosave           python/lab/*.py              D1 (migrations/0001_init.sql)
 src/notebook/*  .ipynb, Markdown,  src/runtime/bridge.ts        cron: server/sweep.ts, once a day
                 sanitizer            Transformers.js, ...
 src/runtime/host.ts  page-only services for the worker:
   audio, the token dialog, requests to Hugging Face
```

No UI framework: the pages are built with a few DOM helpers (`src/ui/dom.ts`). Messages between page and worker are listed in `src/runtime/protocol.ts`.

**Addresses.** Every view has its own address: `/` (the playground, or "My courses" when signed in), `/playground`, `/courses`, `/course?id=…`, `/assignment?id=…`, `/starter?id=…`, `/submission?id=…&student=…`, `/account`, `/privacy`, `/reset`. Each one is a real file: the build copies `index.html` to `courses.html`, `course.html` and so on (`vite.config.ts`), and Cloudflare serves `/course` from `course.html`. So reload and back/forward work on every view without the Worker serving pages, and any other address is a real 404 (`404.html`). Which course or assignment is meant is in the query string; an id that does not exist gets the app's "Not found" page.

**The same API in two places.** `server/app.ts` runs on Cloudflare Workers with D1 (`worker/index.ts`) and on Node with SQLite (`server/server.ts`, through a D1-style interface in `server/db.ts`). Local development and the API tests use the Node side with the real migration file.

What loads from where:

| What | From | Pinned version |
|---|---|---|
| The app (HTML, CSS, JS, the six notebooks, the `lab` sources, formula fonts) | this site | |
| Accounts, courses, notebooks, submissions | this site's `/api` (same origin) | |
| Pyodide (Python 3.14 as WebAssembly) and its packages (NumPy, ...) | `cdn.jsdelivr.net/pyodide/` | 314.0.8 |
| Transformers.js (`@huggingface/transformers`), imported inside the worker on first use | `cdn.jsdelivr.net/npm/` | 4.3.2 |
| The Hugging Face client (`@huggingface/inference`), imported by the page on first use | `cdn.jsdelivr.net/npm/` | 4.13.33 |
| Model files | `huggingface.co` (cached by the browser) | set in each notebook |

Bundled with the app (npm): CodeMirror 6, `marked`, DOMPurify, KaTeX, `fflate` (the zip of all submissions). The Worker: `hono`. Development only: Vite, TypeScript, vitest, jsdom, wrangler, `@hono/node-server`, and `pyodide` 314.0.8 (the exact version production loads from the CDN, used by the tests). Which address each runtime part loads from is decided in one file, `src/config.ts`.

### How Python and JavaScript talk

- The worker registers the JavaScript bridge as the Python module `_lab_js`. Python calls `_lab_js.call(method, json, buffers)` and gets a promise; JavaScript answers with `{ json, buffers }`.
- A value crosses as **one JSON string plus a list of typed arrays**. Inside the JSON, an array is a placeholder (`{"__nd__": 0, "dtype": "float32", "shape": [2, 3]}`); on the Python side it becomes a NumPy array, on the JavaScript side a typed array or a Transformers.js tensor. Tensors, audio (`{audio, sampling_rate}`) and images coming back from a model are converted the same way. This keeps the border simple: no proxy objects to free, plain Python data on the Python side.
- JavaScript errors arrive in Python as ordinary exceptions (`lab.LabError`, `ValueError`, `PermissionError`, ...) with tracebacks that start in the student's cell.
- **With or without `await`.** Functions that wait for the browser are coroutines: `result = await pipe(audio)`. In browsers with JavaScript Promise Integration (JSPI; `pyodide.ffi.can_run_sync()` is true) the same functions wait by themselves, so `result = pipe(audio)` also works, including inside an ordinary `def`. A result returned that way can still be awaited, so a notebook written with `await` runs everywhere. `lab.sync_calls()` reports which mode is active; `lab.sync_calls(False)` switches the automatic waiting off.
- **The token never reaches notebook code.** The student's Hugging Face token is typed into a dialog of the page and kept in that browser's localStorage. Requests to Hugging Face are made by the page (`src/runtime/host.ts`), not by the worker, with a fixed list of option names. Python only learns *whether* a token is set. If the token appears in an output or is pasted into a cell, it is replaced by `[hidden: Hugging Face token]` on screen, in every saved copy (browser and server) and in the downloaded file.

## Data model

One migration, `migrations/0001_init.sql`. Times are UTC milliseconds. Notebooks are stored as compact `.ipynb` JSON text.

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id`, `email` (unique), `name`, `role`, `password_hash`, `created_at` | `role` is `teacher` or `student` and only shapes the home page |
| `sessions` | `token_hash` (key), `secret_hash`, `user_id`, `expires_at` | hashes of the cookie's token and of the header's secret; 30 days, extended while in use |
| `password_resets` | `token_hash` (key), `user_id`, `expires_at` | single use; 60 minutes from an email, 24 hours from `reset-link` |
| `rate_limits` | `key`, `count`, `reset_at` | fixed windows |
| `courses` | `id`, `owner_id`, `name`, `term`, `description`, `join_code` (unique), `join_open`, `archived_at` | the owner is the teacher |
| `enrollments` | (`course_id`, `user_id`), `joined_at` | the students of a course |
| `assignments` | `id`, `course_id`, `title`, `instructions`, `due_at`, `points`, `state`, `grades_released_at`, `starter_name`, `starter_version`, `starter` | `state` is `draft`, `published` or `closed` |
| `work` | (`assignment_id`, `user_id`), `course_id`, `version`, `updated_at`, `notebook` | a student's own copy; `version` goes up with every save |
| `submissions` | (`assignment_id`, `user_id`), `course_id`, `submitted_at`, `first_submitted_at`, `count`, `late`, `checks_passed`, `checks_total`, `grade`, `feedback`, `graded_at`, `notebook` | the latest snapshot; the checks are what the browser reported |

What deleting takes along (foreign keys with `ON DELETE CASCADE`, tested in `server/migrations.test.ts`):

- an **account**: its sessions and reset links, the courses it owns (and everything in them), its enrollments;
- a **course**: its enrollments and assignments;
- an **enrollment** (a student leaves or is removed): that student's work, submissions and grades in the course;
- an **assignment**: every student's copy, submission and grade for it.

`work` and `submissions` name their course as well as their assignment, and the database checks that the two agree and that the student is enrolled.

### The API

All under `/api`, all JSON. `S` = needs to be signed in, `T` = only the course's teacher, `St` = only a student of the course. People who are neither get 404.

| Route | | What it does |
|---|---|---|
| `GET /config` | | whether accounts exist here, whether reset emails can be sent, the data controller |
| `GET /auth/session` | | who is signed in (`user: null` if nobody) |
| `POST /auth/register`, `/auth/login` | | start a session: sets the cookie, returns the session secret once |
| `POST /auth/logout`, `/auth/password`, `/auth/profile`, `/auth/delete` | S | sign out, change password, change name or role, delete the account (asks for the password) |
| `POST /auth/forgot`, `/auth/reset` | | email a reset link (503 without the email binding); set a new password with a link's token |
| `GET /courses`, `POST /courses`, `POST /courses/join` | S | my courses; create one; join by code |
| `GET /courses/:id` | S | the course: for the teacher with join code, roster and assignments; for a student with their assignments and status |
| `PATCH /courses/:id`, `DELETE /courses/:id`, `POST /courses/:id/code`, `DELETE /courses/:id/students/:userId` | T | change, archive, delete; new join code; remove a student |
| `POST /courses/:id/leave` | St | leave |
| `POST /courses/:id/assignments` | T | create a draft |
| `GET /assignments/:id` | S | for the teacher with the table of students; for a student with their own status (and grade, once released) |
| `PATCH /assignments/:id`, `DELETE /assignments/:id` | T | fields, state, release of grades; delete |
| `GET /assignments/:id/starter`, `PUT /assignments/:id/starter?version=N&name=…` | T | read and store the starter (the notebook is the request body) |
| `POST /assignments/:id/work`, `PUT /assignments/:id/work?version=N` | St | open (the first time: copy the starter); save on top of version N, else 409 |
| `POST /assignments/:id/submit` | St | snapshot of the saved copy, with the reported checks |
| `GET /assignments/:id/submissions/:userId`, `PUT …/grade` | T | one submission with its notebook; grade and feedback |

## Security model

**The threat.** Notebook code is untrusted, and it runs in the browser of whoever opens the notebook: a student who downloads something from the internet, and a teacher who opens and runs a student's submission. The code runs in a Web Worker that has the same origin as the site. A cell can call `fetch("/api/...")`, and the browser attaches the site's cookies to that request. With cookies alone as the proof of being signed in, a submitted notebook could read every student's work, change grades or delete the course the moment the teacher runs it.

**The defence: the API cannot be used from the worker.**

- A request is signed in only with **both** the session cookie (HttpOnly, `SameSite=Strict`, path `/api`) **and** a per-session secret in the header `X-Session-Secret`. The secret is returned once, when the session starts (sign-up, sign-in, password reset), and the page keeps it in `localStorage`. Workers have no `localStorage`, so code in a notebook can send the cookie but never the secret. The database stores only SHA-256 hashes of both. No route ever returns the secret again.
- The secret stays in one file, `src/api.ts`. It is never put into a message to the worker, IndexedDB, Cache Storage, a BroadcastChannel or an address, and it is sent only to this site's own `/api/` (same origin, redirects refused).
- Every state-changing request must be JSON and must come from this site (`Origin` and `Sec-Fetch-Site` are checked).
- The API only ever answers `application/json`, with `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and a `Content-Security-Policy` that allows nothing. A stored notebook leaves the server only as JSON inside such an answer, never with a script or HTML type. Downloads (`.ipynb`, zip, CSV) are built in the browser, so no file name from a user ever reaches a response header; names in the zip are sanitized (`src/lib/export.ts`), and the name of a starter is cleaned before it is stored.
- The page treats every message from the worker as untrusted (`src/runtime/client.ts`): each field is checked, unknown messages are dropped, and the only things the worker can ask the page for are the four methods of `src/runtime/host.ts` (decode audio, record after a dialog, open the token dialog, call Hugging Face with a fixed list of options). None of them reaches the API, the session or the page's storage. Do not add one that does.

**What proves it.** `tests/e2e/accounts.mjs`: a student's submission, saved through the API without ever using the page, contains a cell that calls fifteen API routes with `credentials: "include"`: read the courses, the roster and another student's submission, rename and delete the course, grade itself, change the password, delete the account. The signed-in teacher opens it and runs it. The requests leave the worker with the teacher's cookie (the test reads the request headers) and without the secret. Thirteen get 401, `/auth/session` answers that nobody is signed in, and sign-out is answered and ignored; afterwards the course, the roster, the grades and the teacher's session are unchanged. The test also checks that the secret is in no message to the worker, in no address, in IndexedDB, Cache Storage or a readable cookie, and that the page sends it to `/api/` of this site only. `server/app.test.ts` checks the same on the server: cookie without secret, secret without cookie, a wrong secret and another session's secret are all refused.

**What it depends on.**

- **No foreign script on the page.** A script that runs in the page itself can read `localStorage` (the session secret, the Hugging Face token) and act as the person. Two things keep notebook content from becoming script: the sanitizer (DOMPurify, `src/notebook/sanitize.ts`) on every piece of Markdown and HTML, including assignment instructions and feedback, and the Content-Security-Policy in `public/_headers` (no inline script, scripts only from this site and jsDelivr). Loosening either one weakens this model.
- **No address on this site serves a user's content as a script or a page.** If one did, notebook code could load it as a service worker or a document of this origin. That is why the API answers JSON only and why uploads are never served as files.
- **The browser.** `localStorage` not being available in workers, HttpOnly cookies and the same-origin policy are properties of the browser.

**What it does not defend against.**

- A notebook can **sign the browser out**: it can call the sign-in route with other credentials, which replaces the session cookie. The page then gets 401 and asks to sign in again. Nothing is read or changed, but it is a nuisance, and it tells you something about the notebook.
- A notebook can use the **public routes** like anybody on the internet (sign up, try to sign in, within the rate limits), and it can send what it knows itself (its own content) anywhere: `connect-src` allows any https address, because notebooks download models and data.
- A notebook can show **misleading output**, use the CPU and memory of the tab, and make the page ask for the microphone or the Hugging Face token (both ask the person first).
- A notebook you run can **use your Hugging Face token**, if you have set one in this browser: it can call hosted models through `lab.inference`, which counts against your Hugging Face quota. It cannot read the token or send it anywhere else. If that matters, review submissions in a browser profile without a token, or remove the token first ("HF token" button).
- **Check counts** come from the student's browser and can be made up. They are shown as a report, never as a fact; a teacher who needs to know runs the notebook.
- On a **shared computer**, the session secret and the copies of course notebooks stay in the browser until the person signs out. Signing out removes them.
- Sign-up tells whether an email address already has an account.

## Limits

Enforced by the server (`shared/limits.ts`), each with a message that says what to do:

| | |
|---|---|
| A stored notebook (starter, copy, submission) | 1 MB as compact JSON |
| Courses a person teaches | 30 |
| Courses a person is a student in | 50 |
| Students in a course | 300 |
| Assignments in a course | 60 |
| Name 80, course name 100, title 150 characters; instructions 20,000; feedback 10,000 | |
| Points and grades | 0 to 10,000, two decimals |
| Sign-ups | 10 per hour per address |
| Failed sign-ins | 10 per 15 minutes per account and address; 30 sign-in attempts per 15 minutes per address |
| Reset emails | 3 per hour per account, 10 requests per hour per address |
| Join-code attempts | 20 per 15 minutes per person |
| Writes (saves included) | 600 per 10 minutes per person |

**The 1 MB limit.** D1 stores at most 2 MB in one value. When a notebook is larger than 1 MB, the page leaves the largest binary outputs out of the copy it sends: images, and sound or video, also when they are embedded in an HTML output (which is how `lab.play` shows a player). Each is replaced by a line that says what was left out; the save state says "Saved on the server without N large outputs" and a notice names them. Code, Markdown and text outputs are never dropped: if the notebook is still too large, it is not saved on the server and the page says so. The page, the copy in the browser and the downloaded file keep everything. What is submitted is the server's copy, so a teacher sees the note instead of the picture and can run the cell.

**Storage.** D1 holds 500 MB on the free plan and 10 GB on the paid plan. A typical notebook with text outputs is 20 to 100 kB, and each student has up to two per assignment (the copy and the submission). A course of 100 students with 10 assignments of 100 kB each is about 200 MB.

**Offline.** Work in an open tab continues without a connection and is saved on the server when the connection is back; a tab closed in that state restores the work on the next visit. Opening an assignment for the first time on a device needs the server.

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

The download sizes are estimates from the models' parameter counts, not measurements; the notebooks print the real size after loading. Notebook 05 trains 4000 steps in about 2.7 s under CPython on the machine that built this; in the browser expect it to be a few times slower (not measured).

Notebooks 01 and 03 are handed out with the exercise unsolved, so their exercise checks fail until the student completes the function. Reference solutions are in `tests/python/solutions.py`.

## Test checklist for a real laptop

None of the model paths could be run where this was built (no graphics card, no access to the CDNs or to Hugging Face). Please run this once in **Chrome or Edge** on a laptop with a graphics card, and once more on a machine without one if you can. Steps 1 to 16 are about the notebook engine and work in the playground, without an account; steps 17 to 20 are about accounts and need the deployed site (or `npm run dev`).

Before you start: `npm install && npm run dev`, open the page (signed out, or "Playground" in the navigation), open DevTools (F12) on the Console tab, and note the browser version and the graphics card (`chrome://gpu`, or the output of notebook 00).

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
| 15 | `npm run build && npm run db:migrate:local && npx wrangler dev`, repeat steps 2 and 5 at the address it prints. | The same results under the site's Content-Security-Policy. | Console lines that start with "Refused to …": they name what `public/_headers` must allow. |
| 16 | Open the page on a phone. | Notebooks are readable, nothing scrolls sideways. Running models there is not a goal. | |
| 17 | On the deployed site: create a teacher account, a course, and an assignment from sample **01**. Publish it. | The course page shows a join code; the assignment page shows the empty table. | Anything unclear in the wording. |
| 18 | In a private window: create a student account, join with the code, open the assignment, run the Whisper cells, wait for "Saved on the server", reload. | The work and its outputs are back after the reload. With an audio player in the outputs the notebook may pass 1 MB: then the state says "Saved on the server without N large outputs" and a notice names them. | The size of the notebook when that happens (Download, then look at the file). |
| 19 | As the student: Submit. As the teacher: reload the assignment page, open the submission, run a cell, give a grade and feedback, release. As the student: reload. | The teacher sees the outputs as submitted; the student sees grade and feedback only after the release. | |
| 20 | As the teacher: "Download all (.zip)" and "Export table (.csv)"; open the CSV in Excel or LibreOffice. | One notebook per student in the zip; names and feedback show as text in the spreadsheet. | |

### What was verified here, and what was not

"Here" is the machine this was built on: no graphics card, no access to jsDelivr, Hugging Face or Cloudflare.

| | Verified in this environment | Not verified |
|---|---|---|
| Notebook engine | In Chromium with real Pyodide 314.0.8 (served from the npm package): running cells, streaming, errors, top-level await, restart (also of an endless loop), keyboard, open/download round trip, drag and drop, check cells, autosave (also with full storage), 1280 and 390 px, light and dark, no console errors. The same tests pass with the new site header and with the API next to the site | Other browsers (Firefox, Safari); Pyodide loaded from the CDN |
| Accounts, courses, assignments | In Chromium against the **real Worker under `wrangler dev`** (workerd) with a **local D1** whose schema was applied by `wrangler d1 migrations apply`, and again against the Node server: a teacher signs up, makes a course and an assignment, edits the starter, publishes; a student in a second browser context joins, works, reloads, submits; the teacher sees it, runs a cell, grades, releases; the student sees the grade. Conflicts between two tabs, work while offline, the 1 MB limit, new join code, joining off, removing a student, closing, leaving, name and password changes, password reset with a link from `scripts/reset-link.ts`, deleting the account | **A real deployment; the remote D1 database** (it was not touched: the migration has only been applied to local databases); Cloudflare's limits on CPU time |
| Authorization | 43 API tests on SQLite with the real migration: every route's validation; a student cannot read another student's work, the starter of a draft, grades before the release, or anything in a course they are not in; a teacher cannot touch another teacher's course; removed students lose access; cookie without the header secret is refused, and the reverse | |
| Session security | The attack described under "Security model", in the browser against the real Worker; malicious Markdown, stored HTML/SVG outputs, instructions and feedback: nothing runs. Pages and Pyodide run under the Content-Security-Policy of `public/_headers`, served by wrangler | The policy with the real CDN libraries (the ONNX runtime may need something more); a review by somebody else |
| Database | The migration applies to an empty database statement by statement, and again; foreign keys; what deleting an account, a course, an assignment or an enrollment removes (SQLite and local D1) | Applying it to the remote database |
| Downloads | Zip of all submissions (names sanitized and unique, contents checked after unzipping), CSV (formula escaping checked on a student named `=HYPERLINK(...)`), single notebooks | Opening the CSV in Excel |
| Without a database | The real Worker without the D1 binding: the API answers 503, the page is the playground only, no sign-in button, no console errors | A real pull-request preview |
| Cron | `scheduled()` with a database runs the sweep; the sweep deletes exactly the expired rows (SQLite) | The trigger firing on Cloudflare |
| Email | The reset email and its single-use link on the Node server (emails handed to the test); without the binding, the dialog names the contact and the link script works against local D1 | **Sending through Cloudflare's email service** (`send_email` is commented out; the call to the binding is written the way Cell by Cell's Worker makes it and has not run) |
| Layout | Teacher home, course, assignment table, submission review, account, privacy, student home, course and assignment at 1280 and 390 px: nothing sticks out sideways; light and dark; tab order and visible focus on the course page; dialogs take and release the keyboard | A screen reader; real phones |
| NumPy | The NumPy notebooks (00, 04, 05) and the NumPy code of 01 to 03 run under CPython 3.13 with NumPy 2.5; the NumPy side of the converter and of `lab.show`/`lab.play` is tested there | **NumPy inside Pyodide in the browser** (the package cannot be downloaded here; the failure message was tested instead) |
| `lab` bridge | Against stand-ins with the same shapes as Transformers.js: conversion both ways, tensors, audio, images, caching, progress in the status line, CPU fallback, error messages; in the browser and in Node | **Real model downloads; WebGPU execution; the exact model ids;** real output formats of every pipeline |
| Tokens and probabilities | Tokenizer calls and the softmax/top-k of `next_token_probs` against a stand-in model with known logits | `AutoModelForCausalLM` with a real ONNX model (experimental) |
| Calls without `await` | JSPI was available in the test Chromium: `lab` calls work with and without `await` against the stand-ins | The same with real, long-running model calls |
| Audio | Decoding and resampling a WAV file on the page; recording from Chromium's fake microphone through the dialog; cancel; a simulated refusal | A real microphone and the real permission prompt; mp3/ogg/flac files; the Hugging Face sample file |
| Hosted models | The page-side client against a stand-in: arguments, missing token, the token never in Python, outputs, autosave or the file | **The real Inference API**, the model ids, provider routing, error texts |
| Deploy | `npm run build`; `wrangler deploy --dry-run` (bundles the Worker, lists the D1 binding and the variables) | A real deployment |
| CI | The commands of `.github/workflows/ci.yml`, run by hand | The workflow on GitHub |

## Known limits

- **No PyTorch, TensorFlow or JAX.** Pyodide has NumPy, SciPy, scikit-learn, pandas, matplotlib and pure-Python packages. Models run through Transformers.js (ONNX), for inference only.
- **No training of real models.** Training in NumPy on the CPU is fine for toy problems (notebook 05). Fine-tuning a transformer is not possible here.
- **Hardware decides.** WebGPU needs a recent Chrome or Edge (and a supported graphics card); elsewhere models run on the CPU in a single thread and are much slower. Models must fit into the memory of the tab: small models (tens to a few hundred MB) are realistic, multi-gigabyte ones are not. Every student downloads every model once.
- **Checks in the browser can be tampered with.** A student can edit a check cell, remove the tag, or report any numbers at all. The numbers a submission carries are labelled as reported by the student's browser. Grades that must be trusted need a run on a machine the student does not control; the teacher's "run it yourself" in the review view is the manual version of that.
- **One teacher per course.** No co-teachers or teaching assistants, no groups, no per-student deadlines.
- **Grades are per submission.** A student who did not submit cannot be given a grade. A grade given before a re-submission stays and is marked as given for an earlier submission.
- **Leaving a course deletes the work.** A student who leaves, or is removed, loses their copy, submissions and grades in that course at once; the dialogs say so. There is no trash.
- **No history.** The server keeps the latest saved copy and the latest submission, not earlier versions.
- **Stopping a cell means restarting.** Without cross-origin isolation there is no way to interrupt Python, so the only stop is "Restart", which also forgets the variables and the loaded models (the files stay cached).
- **Cross-origin isolation is off.** The site does not send COOP/COEP headers. Turning them on would give the CPU fallback several threads, but then every cross-origin file must be served in a compatible way. That has to be tested with jsDelivr and Hugging Face first.
- **Browser storage.** The playground and the local copies of course notebooks use localStorage (about 5 MB per site). When it is full, a notebook is kept there without outputs and the page says so; course notebooks are on the server anyway.
- **matplotlib** figures are shown after a cell on a best-effort basis that has not been tested; the samples draw with `lab.show` and SVG instead.
- **Secrets in localStorage** (the session secret, a Hugging Face token) are readable by any script that runs in the page. The sanitizer and the Content-Security-Policy are there to keep foreign scripts out; see "Security model".
- No analytics. One cookie, the session cookie, and only for people who sign in.

## Next steps

1. **Deploy and run the checklists above**, and fix what they find: model ids, dtype defaults per device, the Content-Security-Policy, `next_token_logits`, the CPU limit.
2. **Grading that can be trusted:** read nbgrader's metadata (`grade`, `solution`, `locked`, `points`) in addition to the `check` tag, lock test cells in the student view, keep hidden tests out of the student's copy, and re-run submissions in a controlled runtime (for NumPy-only work, the same notebooks run under ordinary CPython, as the tests here do).
3. **Teaching in practice:** co-teachers, extensions for single students, comments on cells, a history of submissions, email when grades are released.
4. **Hand-off to Colab** for assignments that need PyTorch or a real GPU: an "Open in Colab" action for the same `.ipynb`, with a `lab` package for Colab that offers the same calls on top of `transformers`.
5. **Runtime work:** interrupt instead of restart and multi-threaded CPU fallback (both need cross-origin isolation), a model cache page (what is downloaded, how large, delete), streaming text generation, self-hosting Pyodide and the libraries so that a class does not depend on a CDN, tests in Firefox and Safari.
6. **Larger notebooks:** store notebooks in R2 instead of D1 if 1 MB turns out to be too small for audio and image work.

## Repository layout

```
index.html, src/          the app (TypeScript)
  src/app.ts              header, navigation, which view shows
  src/views/              notebook, courses, course, assignment, review, account, privacy
  src/api.ts, session.ts  the page's side of the API; who is signed in
  src/sync.ts             autosave to the server on top of the copy in the browser
  src/notebook/           .ipynb, Markdown, sanitizer, fitting a notebook into 1 MB
  src/runtime/            the Python worker and what the page does for it
shared/limits.ts          limits and rules that server and page both use
server/                   the API (Hono), SQLite for local runs, rate limits, the daily sweep
worker/index.ts           Cloudflare Workers entry
migrations/               the D1 schema
scripts/                  dev.mjs (API + Vite), reset-link.ts
python/lab/               the lab package (Python, bundled into the worker)
notebooks/                the six sample notebooks
public/_headers           security headers for the pages and files
wrangler.jsonc            Cloudflare: assets, Worker for /api/*, D1, cron
tests/unit/               vitest: lab against Pyodide in Node, project checks (more tests sit next to the code in src/ and server/)
tests/python/             the notebooks and the lab package under CPython
tests/e2e/                the app in Chromium (Playwright), against the Node server and the Worker under wrangler dev
tests/stubs/              stand-ins for Transformers.js and the Hugging Face client
```
