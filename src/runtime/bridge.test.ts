import { describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../config.ts'
import type { DisplayOutput } from '../notebook/ipynb.ts'
import { createBridge, fromWire, probeDevice, toWire, type BridgeDeps, type DeviceInfo } from './bridge.ts'
import type { Status } from './protocol.ts'

const config: RuntimeConfig = { pyodideIndexUrl: '/pyodide/', transformersUrl: 'stub:transformers', hfInferenceUrl: 'stub:inference' }

const noGpu: DeviceInfo = {
  webgpu: false,
  adapter: null,
  shader_f16: false,
  browser: 'test',
  user_agent: 'test',
  cross_origin_isolated: false,
  cpu_threads: 4,
  device_memory_gb: null,
  jspi: false,
}

function harness(device: DeviceInfo = noGpu, overrides: Partial<BridgeDeps> = {}) {
  const statuses: Status[] = []
  const streams: Array<[string, string]> = []
  const displays: DisplayOutput[] = []
  const hostCalls: Array<{ method: string; params: unknown }> = []
  let numpyAsked = 0
  const deps: BridgeDeps = {
    config,
    // The same stub the end-to-end tests use, imported directly.
    importModule: (url) => (url === 'stub:transformers' ? import('../../tests/stubs/transformers.js' as string) : Promise.reject(new Error(`cannot import ${url}`))),
    host: async (method, params) => {
      hostCalls.push({ method, params })
      if (method === 'audio.decode') return { samples: new Float32Array([0.1, 0.2]), sr: (params as { sr: number }).sr }
      if (method === 'token.dialog') return { set: true }
      if (method === 'inference') return { text: 'reply', response: {} }
      throw new Error('unexpected host call')
    },
    status: (status) => statuses.push(status),
    stream: (name, text) => streams.push([name, text]),
    display: (output) => displays.push(output),
    ensureNumpy: async () => {
      numpyAsked += 1
      return true
    },
    runtime: { pyodide: 'test', python: '3.x' },
    ...overrides,
  }
  const bridge = createBridge(deps, device, false)
  const call = async (method: string, params: unknown, buffers: ArrayBufferView[] = []) => {
    const wire = await bridge.call(method, JSON.stringify(params), buffers)
    return { value: JSON.parse(wire.json), buffers: wire.buffers }
  }
  return { bridge, call, statuses, streams, displays, hostCalls, numpy: () => numpyAsked }
}

describe('toWire / fromWire', () => {
  it('turns typed arrays, tensors, audio and images into array placeholders with buffers', async () => {
    const wire = await toWire({
      plain: [1, 'two', true, null, undefined, 2.5],
      typed: new Float32Array([1, 2, 3]),
      tensor: { data: new Float32Array(6), dims: [2, 3], type: 'float32' },
      ids: new BigInt64Array([1n, 2n]),
      audio: { audio: new Float32Array(4), sampling_rate: 16000 },
      image: { data: new Uint8ClampedArray(12), width: 2, height: 2, channels: 3 },
      big: 9n,
      nan: NaN,
      fn: () => 1,
      bytes: new Uint8Array([1, 2]).buffer,
    })
    expect(JSON.parse(wire.json)).toEqual({
      plain: [1, 'two', true, null, null, 2.5],
      typed: { __nd__: 0, dtype: 'float32', shape: [3] },
      tensor: { __nd__: 1, dtype: 'float32', shape: [2, 3] },
      ids: { __nd__: 2, dtype: 'int64', shape: [2] },
      audio: { audio: { __nd__: 3, dtype: 'float32', shape: [4] }, sampling_rate: 16000 },
      image: { __nd__: 4, dtype: 'uint8', shape: [2, 2, 3] },
      big: 9,
      nan: null,
      bytes: { __bytes__: 5 },
    })
    expect(wire.buffers).toHaveLength(6)
    expect(wire.arrays).toBe(5)
  })

  it('reads tensors through getters, like the real Tensor class', async () => {
    class Tensor {
      #data = new Int32Array([1, 2, 3, 4])
      get data() {
        return this.#data
      }
      get dims() {
        return [2, 2]
      }
    }
    const wire = await toWire([new Tensor()])
    expect(JSON.parse(wire.json)).toEqual([{ __nd__: 0, dtype: 'int32', shape: [2, 2] }])
  })

  it('reads blobs', async () => {
    const wire = await toWire({ file: new Blob([new Uint8Array([7, 8, 9])]) })
    expect(JSON.parse(wire.json)).toEqual({ file: { __bytes__: 0 } })
    expect(Array.from(wire.buffers[0] as Uint8Array)).toEqual([7, 8, 9])
  })

  it('turns placeholders back into typed arrays and tensors', () => {
    class Tensor {
      constructor(
        public type: string,
        public data: ArrayBufferView,
        public dims: number[],
      ) {}
    }
    const buffers = [new Float32Array([1, 2]), new Float64Array(6), new Uint8Array([1])]
    const value = fromWire(
      JSON.stringify({ a: { __nd__: 0, dtype: 'float32', shape: [2] }, b: [{ __nd__: 1, dtype: 'float64', shape: [2, 3] }], c: { __bytes__: 2 }, d: 'x' }),
      buffers,
      { Tensor },
    ) as { a: unknown; b: Tensor[]; c: unknown; d: string }
    expect(value.a).toBe(buffers[0])
    expect(value.b[0]).toBeInstanceOf(Tensor)
    expect([value.b[0].type, value.b[0].dims]).toEqual(['float64', [2, 3]])
    expect(value.c).toBe(buffers[2])
    expect(value.d).toBe('x')
  })
})

describe('probeDevice', () => {
  it('reports no WebGPU when the browser has none or refuses', async () => {
    expect((await probeDevice({ navigator: {} })).webgpu).toBe(false)
    expect((await probeDevice({ navigator: { gpu: { requestAdapter: async () => null } } })).webgpu).toBe(false)
    const failing = { gpu: { requestAdapter: () => Promise.reject(new Error('blocked')) } }
    expect((await probeDevice({ navigator: failing })).webgpu).toBe(false)
  })

  it('reports the adapter when there is one', async () => {
    const info = await probeDevice({
      crossOriginIsolated: true,
      navigator: {
        gpu: { requestAdapter: async () => ({ info: { vendor: 'acme', architecture: 'arch', device: 'd', description: 'Acme GPU', extra: 1 }, features: new Set(['shader-f16']) }) },
        userAgent: 'UA',
        userAgentData: { brands: [{ brand: 'Not)A;Brand', version: '8' }, { brand: 'Chromium', version: '150' }] },
        hardwareConcurrency: 8,
        deviceMemory: 16,
      },
    })
    expect(info).toMatchObject({
      webgpu: true,
      adapter: { vendor: 'acme', architecture: 'arch', device: 'd', description: 'Acme GPU' },
      shader_f16: true,
      browser: 'Chromium 150',
      user_agent: 'UA',
      cross_origin_isolated: true,
      cpu_threads: 8,
      device_memory_gb: 16,
    })
  })
})

describe('the bridge with the stub library', () => {
  it('creates a pipeline once per (task, model, device, dtype) and reports size and device', async () => {
    const h = harness()
    const first = (await h.call('pipeline.create', { task: 'text-generation', model: 'stub/a', device: 'auto', dtype: null, options: {} })).value
    const again = (await h.call('pipeline.create', { task: 'text-generation', model: 'stub/a', device: 'auto', dtype: null, options: {} })).value
    const explicit = (await h.call('pipeline.create', { task: 'text-generation', model: 'stub/a', device: 'wasm', dtype: null, options: {} })).value
    const other = (await h.call('pipeline.create', { task: 'text-generation', model: 'stub/a', device: 'auto', dtype: 'q8', options: {} })).value
    expect(first).toMatchObject({ task: 'text-generation', model: 'stub/a', device: 'wasm', dtype: null, size_mb: 3 })
    expect(again.id).toBe(first.id)
    expect(explicit.id).toBe(first.id)
    expect(other.id).not.toBe(first.id)
    expect(other.dtype).toBe('q8')
    expect(h.statuses.some((s) => s.kind === 'download' && /Loading stub\/a: onnx\/model\.onnx \d+%/.test(s.text) && typeof s.progress === 'number')).toBe(true)
    expect(h.statuses[0]).toEqual({ kind: 'loading', text: 'Loading Transformers.js' })
  })

  it('creates the same pipeline only once when two cells ask at the same time', async () => {
    const h = harness()
    const params = { task: 'text-generation', model: 'stub/concurrent', device: 'auto', dtype: null, options: {} }
    const [a, b] = await Promise.all([h.call('pipeline.create', params), h.call('pipeline.create', params)])
    expect(a.value.id).toBe(b.value.id)
  })

  it('prefers WebGPU when there is an adapter and falls back to the CPU with a warning', async () => {
    const h = harness({ ...noGpu, webgpu: true })
    const gpu = (await h.call('pipeline.create', { task: 'text-generation', model: 'stub/b', device: 'auto', dtype: null, options: {} })).value
    expect(gpu.device).toBe('webgpu')
    const fallback = (await h.call('pipeline.create', { task: 'text-generation', model: 'stub/cpu-only', device: 'auto', dtype: null, options: {} })).value
    expect(fallback.device).toBe('wasm')
    expect(h.streams.some(([name, text]) => name === 'stderr' && text.includes('did not load on the graphics card'))).toBe(true)
    // Asked for explicitly, a failing device is an error, not a silent fallback.
    await expect(h.call('pipeline.create', { task: 'text-generation', model: 'stub/cpu-only', device: 'webgpu', dtype: null, options: {} })).rejects.toMatchObject({
      name: 'LabError',
      message: expect.stringContaining('Could not load stub/cpu-only'),
    })
  })

  it('passes inputs and options to the pipeline and converts the result', async () => {
    const h = harness()
    const { id } = (await h.call('pipeline.create', { task: 'feature-extraction', model: 'stub/embed', device: 'auto', dtype: null, options: {} })).value
    const result = await h.call('pipeline.call', { id, inputs: ['hello'], options: { pooling: 'mean' } })
    expect(result.value).toEqual({ __nd__: 0, dtype: 'float32', shape: [1, 3, 4] })
    expect(Array.from(result.buffers[0] as Float32Array).slice(0, 3)).toEqual([0, 0.5, 1])
    expect(h.numpy()).toBe(1)

    const echo = (await h.call('pipeline.create', { task: 'echo', model: 'stub/echo', device: 'auto', dtype: null, options: {} })).value
    const echoed = await h.call(
      'pipeline.call',
      { id: echo.id, inputs: [{ __nd__: 0, dtype: 'float32', shape: [3] }, { __nd__: 1, dtype: 'float32', shape: [1, 2] }], options: { n: 1 } },
      [new Float32Array([0.5, 1, 2]), new Float32Array([7, 8])],
    )
    expect(echoed.value.received).toEqual([
      { kind: 'Float32Array', length: 3, first: 0.5 },
      { kind: 'Tensor', type: 'float32', dims: [1, 2], ctor: 'Float32Array', first: 7 },
      { n: 1 },
    ])
  })

  it('gives named errors', async () => {
    const h = harness()
    await expect(h.call('pipeline.create', { task: 'text-generation', model: 'stub/missing', device: 'auto', dtype: null, options: {} })).rejects.toMatchObject({
      name: 'LabError',
      message: expect.stringContaining('Could not load stub/missing: Could not locate file'),
    })
    await expect(h.call('pipeline.create', { task: 't', model: 'm', device: 'cuda', dtype: null, options: {} })).rejects.toMatchObject({ name: 'ValueError' })
    await expect(h.call('pipeline.call', { id: 999, inputs: [], options: {} })).rejects.toMatchObject({ name: 'LabError', message: expect.stringContaining('earlier runtime') })
    await expect(h.call('no.such.method', {})).rejects.toMatchObject({ name: 'LabError' })
    expect(() => h.bridge.call_sync('no.such.method', '{}', [])).toThrow(/unknown bridge method/)
    const failed = harness(noGpu, { importModule: () => Promise.reject(new Error('net::ERR_FAILED')) })
    await expect(failed.call('tokenizer.load', { model: 'm' })).rejects.toMatchObject({
      name: 'LabError',
      message: expect.stringContaining('Could not load Transformers.js from stub:transformers'),
    })
  })

  it('tokenizes, and computes next-token probabilities as the softmax of the last logits', async () => {
    const h = harness()
    const { id } = (await h.call('tokenizer.load', { model: 'stub/gpt' })).value
    const sync = (method: string, params: unknown) => JSON.parse(h.bridge.call_sync(method, JSON.stringify(params), []).json)
    const ids = sync('tokenizer.encode', { id, text: ' the cat sat' })
    expect(ids).toEqual([0, 1, 2])
    expect(sync('tokenizer.tokens', { id, text: ' the cat sat' })).toEqual(['Ġthe', 'Ġcat', 'Ġsat'])
    expect(sync('tokenizer.decode', { id, ids })).toBe(' the cat sat')

    const logits = await h.call('lm.logits', { model: 'stub/gpt', text: ' the cat sat', device: 'auto', dtype: null })
    const expected = [0, 0.5, 1, 4.5, 2, 2.5, 3, 3.5]
    expect(Array.from(logits.buffers[0] as Float32Array)).toEqual(expected)
    const total = expected.reduce((sum, z) => sum + Math.exp(z), 0)
    const probs = (await h.call('lm.probs', { model: 'stub/gpt', text: ' the cat sat', top_k: 3, device: 'auto', dtype: null })).value.top
    expect(probs.map((p: { token: string }) => p.token)).toEqual([' on', ' dog', ' a'])
    expect(probs[0].probability).toBeCloseTo(Math.exp(4.5) / total, 12)
    expect(probs[1].probability).toBeCloseTo(Math.exp(3.5) / total, 12)
    await expect(h.call('lm.probs', { model: 'stub/gpt', text: '', top_k: 3 })).rejects.toMatchObject({ name: 'ValueError' })
  })

  it('forwards audio, the token dialog and hosted models to the page, and never sees a token', async () => {
    const h = harness()
    const sync = (method: string) => JSON.parse(h.bridge.call_sync(method, '{}', []).json)
    expect(sync('token.status')).toEqual({ set: false })
    await h.call('token.dialog', {})
    expect(sync('token.status')).toEqual({ set: true })
    h.bridge.setTokenState(false)
    expect(sync('token.status')).toEqual({ set: false })

    const audio = await h.call('audio.load', { data: { __bytes__: 0 }, sr: 8000 }, [new Uint8Array([1, 2, 3])])
    expect(audio.value).toEqual({ samples: { __nd__: 0, dtype: 'float32', shape: [2] }, sr: 8000 })
    const decode = h.hostCalls.find((c) => c.method === 'audio.decode')!.params as { bytes: ArrayBuffer; sr: number }
    expect(Array.from(new Uint8Array(decode.bytes))).toEqual([1, 2, 3])

    await h.call('inference.chat', { model: 'org/model', messages: [{ role: 'user', content: 'hi' }], options: {}, provider: null })
    const request = h.hostCalls.find((c) => c.method === 'inference')!.params as Record<string, unknown>
    expect(request).toMatchObject({ kind: 'chat', model: 'org/model' })
    expect(JSON.stringify(h.hostCalls)).not.toContain('hf_')
    expect(sync('device')).toMatchObject({ webgpu: false, pyodide: 'test', python: '3.x' })
  })

  it('keeps stdout and stderr in order and joins the pieces of a line', () => {
    const h = harness()
    h.bridge.stream('stdout', 'a')
    h.bridge.stream('stdout', ' ')
    h.bridge.stream('stdout', 'b')
    h.bridge.stream('stdout', '\n')
    h.bridge.stream('stdout', 'partial')
    h.bridge.stream('stderr', 'oops\n')
    h.bridge.emit(JSON.stringify({ output_type: 'display_data', data: { 'text/plain': 'x' }, metadata: {} }))
    h.bridge.stream('stdout', 'tail')
    h.bridge.flush()
    const joined = h.streams.reduce<Array<[string, string]>>((acc, [name, text]) => {
      const last = acc[acc.length - 1]
      if (last && last[0] === name) last[1] += text
      else acc.push([name, text])
      return acc
    }, [])
    expect(joined).toEqual([
      ['stdout', 'a b\npartial'],
      ['stderr', 'oops\n'],
      ['stdout', 'tail'],
    ])
    expect(h.displays).toHaveLength(1)
    // "partial" was flushed before the stderr line and before the display, not after.
    expect(h.streams.findIndex(([, text]) => text.includes('partial'))).toBeLessThan(h.streams.findIndex(([name]) => name === 'stderr'))
  })
})
