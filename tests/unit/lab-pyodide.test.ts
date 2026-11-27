/**
 * The whole bridge without a browser: real Pyodide (from the npm package, in Node), the real `lab`
 * package, the real JavaScript bridge, and the stub model library. NumPy is not available to
 * Pyodide here, so arrays arrive in Python through the documented fallback (nested lists).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { loadPyodide, type PyodideAPI } from 'pyodide'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DisplayOutput } from '../../src/notebook/ipynb.ts'
import { createBridge, type DeviceInfo } from '../../src/runtime/bridge.ts'

let py: PyodideAPI
let runCell: (source: string, label: number) => Promise<string>
const streams: Array<[string, string]> = []
const displays: DisplayOutput[] = []
const hostCalls: Array<{ method: string; params: unknown }> = []
let numpyRequests = 0
let label = 0

const device: DeviceInfo = {
  webgpu: false,
  adapter: null,
  shader_f16: false,
  browser: 'node',
  user_agent: 'node',
  cross_origin_isolated: false,
  cpu_threads: 1,
  device_memory_gb: null,
  jspi: false,
}

async function run(source: string) {
  streams.length = 0
  displays.length = 0
  const result = JSON.parse(await runCell(source, ++label)) as { ok: boolean; ename?: string; evalue?: string; traceback?: string[] }
  const text = (name: string) =>
    streams
      .filter(([n]) => n === name)
      .map(([, t]) => t)
      .join('')
  return { ...result, stdout: text('stdout'), stderr: text('stderr'), displays: [...displays] }
}

beforeAll(async () => {
  py = await loadPyodide({ stdout: () => {}, stderr: () => {} })
  const bridge = createBridge(
    {
      config: { pyodideIndexUrl: '', transformersUrl: 'stub', hfInferenceUrl: 'stub' },
      importModule: () => import('../stubs/transformers.js' as string),
      host: async (method, params) => {
        hostCalls.push({ method, params })
        if (method === 'token.dialog') return { set: false }
        if (method === 'audio.decode') return { samples: new Float32Array([0.25, -0.25, 0.5]), sr: (params as { sr: number }).sr }
        const error = new Error('No Hugging Face token is set.')
        error.name = 'LabError'
        throw error
      },
      status: () => {},
      stream: (name, text) => streams.push([name, text]),
      display: (output) => displays.push(output),
      ensureNumpy: async () => {
        numpyRequests += 1
        return false
      },
      runtime: { pyodide: py.version, python: '3' },
    },
    device,
    false,
  )
  py.registerJsModule('_lab_js', bridge)
  const sitePackages = String(py.runPython('import sysconfig; sysconfig.get_path("purelib")'))
  py.FS.mkdirTree(`${sitePackages}/lab`)
  for (const file of readdirSync('python/lab').filter((name) => name.endsWith('.py'))) {
    py.FS.writeFile(`${sitePackages}/lab/${file}`, readFileSync(`python/lab/${file}`, 'utf8'))
  }
  runCell = py.runPython('import importlib\nimportlib.invalidate_caches()\nfrom lab import _runtime\n_runtime.install()\n_runtime.run_cell') as typeof runCell
}, 120_000)

describe('running cells', () => {
  it('captures stdout, stderr and the last value', async () => {
    const result = await run('import sys\nprint("out", 1 + 1)\nprint("err", file=sys.stderr)\n[1, 2, 3]')
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('out 2\n')
    expect(result.stderr).toBe('err\n')
    expect(result.displays).toEqual([{ output_type: 'execute_result', data: { 'text/plain': '[1, 2, 3]' }, metadata: {} }])
  })

  it('keeps variables between cells, supports top-level await, and hides values behind a semicolon', async () => {
    await run('x = 20')
    const awaited = await run('import asyncio\nawait asyncio.sleep(0)\nx + 1')
    expect(awaited.displays[0].data['text/plain']).toBe('21')
    expect((await run('x;')).displays).toEqual([])
    expect((await run('_')).displays[0].data['text/plain']).toBe('21')
    expect((await run('async def later():\n    return "done"\nlater()')).displays[0].data['text/plain']).toBe("'done'")
  })

  it('reports errors with a traceback that starts in the cell', async () => {
    const result = await run('def f():\n    return 1 / 0\nf()')
    expect(result.ok).toBe(false)
    expect(result.ename).toBe('ZeroDivisionError')
    expect(result.evalue).toBe('division by zero')
    const trace = result.traceback!.join('\n')
    expect(trace).toMatch(/^Traceback \(most recent call last\):\n {2}File "<cell \[\d+\]>", line 3, in <module>\n {4}f\(\)/)
    expect(trace).toContain('return 1 / 0')
    expect(trace).not.toContain('_runtime')
    const syntax = await run('def broken(:\n    pass')
    expect(syntax.ename).toBe('SyntaxError')
    expect(syntax.traceback!.join('\n')).toContain('<cell [')
    expect((await run('raise SystemExit')).ok).toBe(true)
    expect((await run('input("name?")')).evalue).toContain('input() is not available')
  })

  it('uses rich representations', async () => {
    const result = await run('class R:\n    def _repr_html_(self):\n        return "<b>r</b>"\nR()')
    expect(result.displays[0].data['text/html']).toBe('<b>r</b>')
    expect(result.displays[0].output_type).toBe('execute_result')
  })
})

describe('lab through the bridge', () => {
  it('reports the device', async () => {
    const result = await run('import lab\ninfo = lab.device()\nprint(info["webgpu"], info["browser"], info["pyodide"] == __import__("pyodide").__version__)')
    expect(result.stdout).toBe('False node True\n')
  })

  it('loads a pipeline, calls it, and converts in both directions', async () => {
    const result = await run(`
import array, lab
tts = await lab.pipeline("text-to-speech", "stub/tts")
speech = await tts("hi")
print(tts, type(speech).__name__, speech["sampling_rate"], len(speech["audio"]))
echo = await lab.pipeline("echo", "stub/echo")
out = await echo(array.array("f", [0.5, 1.5]), {"k": [1, None]}, b"ab", option=True)
print(out["received"])
print(out["ids"], out["big"], out["nothing"])
features = await (await lab.pipeline("feature-extraction", "stub/embed"))("x")
print(features)
`)
    expect(result.ok, result.traceback?.join('\n')).toBe(true)
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toBe('<lab.Pipeline text-to-speech stub/tts on wasm> dict 16000 3200')
    expect(lines[1]).toBe("[{'kind': 'Float32Array', 'length': 2, 'first': 0.5}, {'k': [1, None]}, {'kind': 'Uint8Array', 'length': 2, 'first': 97}, {'option': True}]")
    expect(lines[2]).toBe('[1, 2, 3] 12 None')
    expect(lines[3]).toBe('[[[0.0, 0.5, 1.0, 1.5], [2.0, 2.5, 3.0, 3.5], [4.0, 4.5, 5.0, 5.5]]]')
    expect(result.stderr).toContain('NumPy could not be loaded')
    expect(numpyRequests).toBeGreaterThan(0)
  })

  it('turns JavaScript errors into Python exceptions with clean tracebacks', async () => {
    const result = await run('import lab\nawait lab.pipeline("text-generation", "stub/missing")')
    expect(result.ename).toBe('LabError')
    expect(result.evalue).toContain('Could not load stub/missing')
    const trace = result.traceback!.join('\n')
    expect(trace).toContain('lab.LabError: Could not load stub/missing')
    expect(trace).not.toContain('site-packages/lab')
    expect(trace).not.toContain('JsException')
    const caught = await run('try:\n    await lab.pipeline("t", "m", device="gpu")\nexcept ValueError as err:\n    print("ValueError:", err)')
    expect(caught.stdout).toContain('ValueError: device must be "auto", "webgpu" or "wasm"')
    const hint = await run('gen = await lab.pipeline("text-generation", "stub/gpt")\ngen("x")[0]')
    expect(hint.traceback!.join('\n')).toContain('Hint: functions that wait for the browser')
  })

  it('tokenizes and returns next-token probabilities as tuples', async () => {
    const result = await run(`
tok = await lab.tokenizer("stub/gpt")
print(tok.encode(" the cat"), tok.tokens(" the cat"), repr(tok.decode([0, 1])))
print(await lab.next_token_probs("stub/gpt", " the cat sat", top_k=2))
print(await lab.next_token_logits("stub/gpt", " the cat sat"))
`)
    expect(result.ok, result.traceback?.join('\n')).toBe(true)
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toBe("[0, 1] ['Ġthe', 'Ġcat'] ' the cat'")
    expect(lines[1]).toMatch(/^\[\(' on', 0\.5353\d+\), \(' dog', 0\.1969\d+\)\]$/)
    expect(lines[2]).toBe('[0.0, 0.5, 1.0, 4.5, 2.0, 2.5, 3.0, 3.5]')
  })

  it('shows outputs: html, table, image bytes, audio', async () => {
    const result = await run(`
lab.html("<b>x</b>")
lab.table([{"a": 1, "b": "<i>"}])
lab.show(b"\\x89PNG\\r\\n\\x1a\\n" + b"\\x00" * 4)
lab.play([0.0, 0.5, -0.5], 8000)
`)
    expect(result.ok, result.traceback?.join('\n')).toBe(true)
    expect(result.displays.map((d) => Object.keys(d.data).sort())).toEqual([
      ['text/html', 'text/plain'],
      ['text/html', 'text/plain'],
      ['image/png', 'text/plain'],
      ['text/html', 'text/plain'],
    ])
    expect(result.displays[1].data['text/html']).toContain('&lt;i&gt;')
    expect(String(result.displays[3].data['text/html'])).toMatch(/^<audio controls preload="metadata" src="data:audio\/wav;base64,UklGR/)
  })

  it('asks the page for audio and for the token, and reports a missing token clearly', async () => {
    hostCalls.length = 0
    const result = await run(`
samples, sr = await lab.load_audio(b"RIFFdata", sr=8000)
print(samples, sr, bool(lab.hf_token()), await lab.set_hf_token())
try:
    await lab.inference.chat("org/model", "hi")
except lab.LabError as err:
    print("LabError:", err)
`)
    expect(result.ok, result.traceback?.join('\n')).toBe(true)
    expect(result.stdout).toBe('[0.25, -0.25, 0.5] 8000 False <Hugging Face token: not set>\nLabError: No Hugging Face token is set.\n')
    expect(hostCalls.map((c) => c.method)).toEqual(['audio.decode', 'token.dialog', 'inference'])
    expect(hostCalls[2].params).toMatchObject({ kind: 'chat', model: 'org/model', messages: [{ role: 'user', content: 'hi' }], provider: null })
  })
})
