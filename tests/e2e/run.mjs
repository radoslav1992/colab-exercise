/**
 * End-to-end tests: `npm run test:e2e` (builds the offline test bundle first).
 *
 *   node tests/e2e/run.mjs [filter]      run only the tests whose name contains the filter
 *   SCREENSHOT_DIR=/some/folder ...      also save screenshots there
 *
 * Needs Playwright with Chromium (see helpers.mjs). Nothing is fetched from the internet: Pyodide
 * comes from node_modules, the model libraries are the stubs in tests/stubs.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register as registerEngine } from './engine.mjs'
import { loadPlaywright, notebook, Suite } from './helpers.mjs'
import { register as registerLab } from './lab.mjs'
import { startServer } from './server.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dist = join(repo, 'dist-e2e')
if (!existsSync(join(dist, 'pyodide', 'pyodide.mjs'))) {
  console.error('dist-e2e is missing. Run `npm run build:e2e` first (or `npm run test:e2e`).')
  process.exit(2)
}

/** Half a second of a 440 Hz tone at 8 kHz, as a WAV file, for lab.load_audio(address). */
function toneWav() {
  const sr = 8000
  const n = sr / 2
  const buffer = Buffer.alloc(44 + n * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + n * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sr, 24)
  buffer.writeUInt32LE(sr * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buffer.writeInt16LE(Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / sr)), 44 + i * 2)
  return buffer
}

/** A notebook that runs without NumPy and without the internet, for the layout tests and screenshots. */
const demoNotebook = notebook([
  {
    md: '# Next-token probabilities\n\nA language model turns a text into one score per token of its vocabulary, the **logits** $z$. The softmax turns scores into probabilities:\n\n$$p_i = \\frac{e^{z_i / T}}{\\sum_j e^{z_j / T}}$$\n\nA temperature $T < 1$ sharpens the distribution, $T > 1$ flattens it.',
  },
  'import lab\n\nMODEL = "stub/gpt"   # the test stub, not a real model\ntok = await lab.tokenizer(MODEL)\ntext = " the cat sat"\nprint(tok.tokens(text))\nprint(tok.encode(text))',
  'probs = await lab.next_token_probs(MODEL, text, top_k=5)\nlab.table([{"token": repr(token), "probability": round(p, 4)} for token, p in probs])',
  {
    md: '## Your turn\n\nComplete `softmax` so that it works for any temperature. The check below tells you whether it is right.',
  },
  'import math\n\ndef softmax(logits, temperature=1.0):\n    scaled = [z / temperature for z in logits]\n    top = max(scaled)\n    exps = [math.exp(z - top) for z in scaled]\n    total = sum(exps)\n    return [e / total for e in exps]\n\nsoftmax([1.0, 2.0, 3.0])',
  {
    code: 'p = softmax([1.0, 2.0, 3.0])\nassert abs(sum(p) - 1) < 1e-12\nassert p[2] > p[1] > p[0]\nassert softmax([0.0, 1.0], temperature=0.5)[1] > softmax([0.0, 1.0])[1]\nprint("softmax works")',
    tags: ['check'],
  },
  'bars = "".join(\n    f\'<rect x="{20 + 44 * i}" y="{130 - 120 * p:.1f}" width="32" height="{120 * p:.1f}" fill="#2553c7"/>\'\n    f\'<text x="{36 + 44 * i}" y="146" font-size="11" text-anchor="middle" fill="currentColor">{token.strip()}</text>\'\n    for i, (token, p) in enumerate(probs)\n)\nlab.html(f\'<svg viewBox="0 0 250 152" width="250" height="152" role="img" aria-label="Bar chart of the five most likely tokens">{bars}</svg>\')',
  { code: 'assert softmax([5.0])[0] == 0.5, "one token must get all the probability"', tags: ['check'] },
])

const { chromium } = loadPlaywright()
const server = await startServer({
  root: dist,
  headersFile: join(repo, 'public', '_headers'),
  extraFiles: { '/test-tone.wav': writeTemp('test-tone.wav', toneWav()) },
})
const browser = await chromium.launch()
// A second browser whose microphone is a fake device that needs no permission prompt.
const micBrowser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })

function writeTemp(name, data) {
  const folder = join(tmpdir(), `notebook-lab-e2e-${process.pid}`)
  mkdirSync(folder, { recursive: true })
  const file = join(folder, name)
  writeFileSync(file, data)
  return file
}

const screenshotDir = process.env.SCREENSHOT_DIR ? resolve(process.env.SCREENSHOT_DIR) : null
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true })

const suite = new Suite()
const env = { browser, micBrowser, url: server.url, screenshotDir, demoNotebook }
registerEngine(suite, env)
registerLab(suite, env)

console.log(`End-to-end tests against ${server.url} (Chromium ${browser.version()})\n`)
let ok = false
try {
  ok = await suite.run(process.argv[2])
} finally {
  await browser.close()
  await micBrowser.close()
  await server.close()
}
process.exit(ok ? 0 : 1)
