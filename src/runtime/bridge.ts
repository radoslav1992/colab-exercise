/**
 * The JavaScript side of the `lab` Python package. It runs in the worker, next to Pyodide, and is
 * registered there as the Python module `_lab_js` (python/lab/_bridge.py is the other side).
 *
 * Values cross as one JSON string plus a list of typed arrays; see python/lab/_convert.py.
 *
 * The model libraries are loaded here, on demand, with a dynamic `import()` from the addresses in
 * src/config.ts. Nothing in this file touches the student's Hugging Face token: hosted-model
 * requests are forwarded to the page (src/runtime/host.ts), which is the only place that has it.
 */
import type { RuntimeConfig } from '../config.ts'
import type { DisplayOutput } from '../notebook/ipynb.ts'
import { NamedError, type HostMethod, type Status } from './protocol.ts'

export interface Wire {
  json: string
  buffers: ArrayBufferView[]
}

export interface BridgeDeps {
  config: RuntimeConfig
  /** Load an ES module by address (a dynamic import in the worker; replaced in tests). */
  importModule(url: string): Promise<unknown>
  /** Ask the page to do something only the page can do. */
  host(method: HostMethod, params: unknown, transfer?: Transferable[]): Promise<unknown>
  status(status: Status): void
  stream(name: 'stdout' | 'stderr', text: string): void
  display(output: DisplayOutput): void
  /** Make NumPy importable in Python. False if it could not be loaded. */
  ensureNumpy(): Promise<boolean>
  /** Facts about the runtime that `lab.device()` reports. */
  runtime: { pyodide: string; python: string }
}

// --- The parts of Transformers.js this file uses ------------------------------------------------
// Declared here instead of importing the package's types: the library is loaded from the CDN at run
// time, and tests/stubs/transformers.js implements exactly this surface.

interface TensorLike {
  data: ArrayBufferView | unknown[]
  dims: number[]
}

interface ProgressInfo {
  status: string
  name?: string
  file?: string
  progress?: number
  loaded?: number
  total?: number
}

type PipelineFn = (...args: unknown[]) => Promise<unknown>

interface TokenizerLike {
  (text: string): unknown
  encode(text: string): number[]
  decode(ids: number[], options?: { skip_special_tokens?: boolean }): string
  tokenize(text: string): string[]
}

interface TransformersModule {
  env: { allowLocalModels?: boolean; [key: string]: unknown }
  pipeline(task: string, model?: string, options?: Record<string, unknown>): Promise<PipelineFn>
  AutoTokenizer: { from_pretrained(model: string, options?: Record<string, unknown>): Promise<TokenizerLike> }
  AutoModelForCausalLM: {
    from_pretrained(
      model: string,
      options?: Record<string, unknown>,
    ): Promise<(inputs: unknown) => Promise<{ logits: TensorLike }>>
  }
  Tensor: new (type: string, data: ArrayBufferView, dims: number[]) => TensorLike
}

// --- Conversion ----------------------------------------------------------------------------------

const DTYPES: Array<[string, string]> = [
  ['Float32Array', 'float32'],
  ['Float64Array', 'float64'],
  ['Int8Array', 'int8'],
  ['Uint8Array', 'uint8'],
  ['Uint8ClampedArray', 'uint8'],
  ['Int16Array', 'int16'],
  ['Uint16Array', 'uint16'],
  ['Int32Array', 'int32'],
  ['Uint32Array', 'uint32'],
  ['BigInt64Array', 'int64'],
  ['BigUint64Array', 'uint64'],
]

function dtypeOf(view: ArrayBufferView): string | null {
  const name = view.constructor.name
  for (const [ctor, dtype] of DTYPES) if (ctor === name) return dtype
  return null
}

function isPlainNumberArray(view: ArrayBufferView): view is ArrayBufferView & ArrayLike<number> {
  return 'length' in view
}

/** JavaScript value -> JSON plus buffers. Tensors, typed arrays, audio and images become arrays. */
export async function toWire(value: unknown): Promise<Wire & { arrays: number }> {
  const buffers: ArrayBufferView[] = []
  let arrays = 0

  const nd = (view: ArrayBufferView, shape: number[]): unknown => {
    let data = view
    let dtype = dtypeOf(view)
    if (dtype === null) {
      // Float16Array and anything newer: widen to float32.
      if (!isPlainNumberArray(view)) throw new NamedError('TypeError', 'lab cannot convert this binary value to Python')
      data = Float32Array.from(view)
      dtype = 'float32'
    }
    buffers.push(data)
    arrays += 1
    return { __nd__: buffers.length - 1, dtype, shape }
  }

  const walk = async (v: unknown, depth: number): Promise<unknown> => {
    if (v === null || v === undefined) return null
    if (depth > 32) return null
    switch (typeof v) {
      case 'number':
        return Number.isFinite(v) ? v : null
      case 'bigint':
        return Number(v)
      case 'string':
      case 'boolean':
        return v
      case 'function':
      case 'symbol':
        return null
    }
    if (ArrayBuffer.isView(v)) return nd(v, [(v as unknown as ArrayLike<number>).length ?? v.byteLength])
    if (v instanceof ArrayBuffer) {
      buffers.push(new Uint8Array(v))
      return { __bytes__: buffers.length - 1 }
    }
    if (typeof Blob !== 'undefined' && v instanceof Blob) {
      buffers.push(new Uint8Array(await v.arrayBuffer()))
      return { __bytes__: buffers.length - 1 }
    }
    if (Array.isArray(v)) {
      const out: unknown[] = []
      for (const item of v) out.push(await walk(item, depth + 1))
      return out
    }
    const obj = v as Record<string, unknown>
    // A tensor: { data, dims }.
    if (Array.isArray(obj.dims) && ArrayBuffer.isView(obj.data)) return nd(obj.data, obj.dims as number[])
    if (Array.isArray(obj.dims) && Array.isArray(obj.data)) return { data: await walk(obj.data, depth + 1), dims: obj.dims }
    // An image: { data, width, height, channels } -> array of shape (height, width, channels).
    if (
      typeof obj.width === 'number' &&
      typeof obj.height === 'number' &&
      typeof obj.channels === 'number' &&
      ArrayBuffer.isView(obj.data)
    ) {
      return nd(obj.data, [obj.height, obj.width, obj.channels])
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(obj)) {
      if (typeof item === 'function' || item === undefined) continue
      out[key] = await walk(item, depth + 1)
    }
    return out
  }

  const json = JSON.stringify(await walk(value, 0))
  return { json, buffers, arrays }
}

/** JSON plus buffers -> JavaScript value. Arrays with one dimension stay typed arrays, others become tensors. */
export function fromWire(json: string, buffers: ArrayLike<ArrayBufferView>, T?: Pick<TransformersModule, 'Tensor'>): unknown {
  return JSON.parse(json, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      if (typeof obj.__nd__ === 'number') {
        const data = buffers[obj.__nd__]
        const shape = obj.shape as number[]
        if (shape.length <= 1) return data
        return T ? new T.Tensor(obj.dtype as string, data, shape) : { data, dims: shape }
      }
      if (typeof obj.__bytes__ === 'number') return buffers[obj.__bytes__]
    }
    return value
  })
}

// --- The bridge ----------------------------------------------------------------------------------

interface LoadedPipeline {
  id: number
  run: PipelineFn
  info: Record<string, unknown>
}

export interface DeviceInfo {
  webgpu: boolean
  adapter: Record<string, string> | null
  shader_f16: boolean
  browser: string
  user_agent: string
  cross_origin_isolated: boolean
  cpu_threads: number | null
  device_memory_gb: number | null
  jspi: boolean
}

/** What the browser offers. Asked once when the worker starts. */
export async function probeDevice(scope: {
  navigator?: unknown
  crossOriginIsolated?: boolean
}): Promise<DeviceInfo> {
  const nav = (scope.navigator ?? {}) as {
    gpu?: { requestAdapter(): Promise<unknown> }
    userAgent?: string
    userAgentData?: { brands?: Array<{ brand: string; version: string }> }
    hardwareConcurrency?: number
    deviceMemory?: number
  }
  interface Adapter {
    info?: unknown
    requestAdapterInfo?: () => Promise<unknown>
    features?: { has(name: string): boolean }
  }
  const adapter: Adapter | null = await (async () => {
    try {
      return nav.gpu ? ((await nav.gpu.requestAdapter()) as Adapter | null) : null
    } catch {
      return null
    }
  })()
  let adapterInfo: Record<string, string> | null = null
  if (adapter) {
    try {
      const info = (adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null)) as Record<
        string,
        unknown
      > | null
      if (info) {
        adapterInfo = {}
        for (const key of ['vendor', 'architecture', 'device', 'description']) {
          if (typeof info[key] === 'string') adapterInfo[key] = info[key] as string
        }
      }
    } catch {
      adapterInfo = null
    }
  }
  const brands = nav.userAgentData?.brands
    ?.filter((b) => !/not.?a.?brand/i.test(b.brand))
    .map((b) => `${b.brand} ${b.version}`)
    .join(', ')
  return {
    webgpu: adapter !== null,
    adapter: adapterInfo,
    shader_f16: Boolean(adapter?.features?.has('shader-f16')),
    browser: brands || nav.userAgent || 'unknown',
    user_agent: nav.userAgent ?? 'unknown',
    cross_origin_isolated: Boolean(scope.crossOriginIsolated),
    cpu_threads: nav.hardwareConcurrency ?? null,
    device_memory_gb: nav.deviceMemory ?? null,
    jspi: typeof (WebAssembly as unknown as { Suspending?: unknown }).Suspending === 'function',
  }
}

/** A dtype is a name ("fp32", "q8", ...) or, as Transformers.js allows, one name per model file. */
function dtypeOption(value: unknown): string | Record<string, string> | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string')) {
    return value as Record<string, string>
  }
  return undefined
}

function megabytes(bytes: number): number {
  return Math.round((bytes / 1e6) * 10) / 10
}

export function createBridge(deps: BridgeDeps, device: DeviceInfo, initialTokenSet: boolean) {
  let transformers: Promise<TransformersModule> | null = null
  const pipelines = new Map<string, Promise<LoadedPipeline>>()
  const pipelinesById = new Map<number, LoadedPipeline>()
  const tokenizers = new Map<string, Promise<{ id: number; tokenizer: TokenizerLike }>>()
  const tokenizersById = new Map<number, TokenizerLike>()
  const languageModels = new Map<string, Promise<{ model: (inputs: unknown) => Promise<{ logits: TensorLike }>; device: string }>>()
  let nextId = 1
  let tokenSet = initialTokenSet

  // Partial lines are held back briefly so that print("a", "b") is one message, not four.
  const pending: { stdout: string; stderr: string } = { stdout: '', stderr: '' }
  let lastFlush = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function flush(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    for (const name of ['stdout', 'stderr'] as const) {
      if (pending[name]) {
        deps.stream(name, pending[name])
        pending[name] = ''
      }
    }
    lastFlush = performance.now()
  }

  function stream(name: string, text: string): void {
    const key = name === 'stderr' ? 'stderr' : 'stdout'
    // Keep the two streams in order.
    const other = key === 'stderr' ? 'stdout' : 'stderr'
    if (pending[other]) flush()
    pending[key] += text
    if (text.endsWith('\n') || performance.now() - lastFlush > 50) flush()
    else if (flushTimer === null) flushTimer = setTimeout(flush, 50)
  }

  function loadTransformers(): Promise<TransformersModule> {
    if (!transformers) {
      deps.status({ kind: 'loading', text: 'Loading Transformers.js' })
      transformers = deps.importModule(deps.config.transformersUrl).then(
        (mod) => {
          const T = mod as TransformersModule
          // Models come from the Hugging Face Hub, never from this site.
          if (T.env) T.env.allowLocalModels = false
          return T
        },
        (err: unknown) => {
          transformers = null
          throw new NamedError(
            'LabError',
            `Could not load Transformers.js from ${deps.config.transformersUrl}. Check your internet connection and run the cell again. (${String(
              (err as Error)?.message ?? err,
            )})`,
          )
        },
      )
    }
    return transformers
  }

  /** A progress callback for Transformers.js that feeds the status line and adds up the file sizes. */
  function progressTracker(label: string) {
    const totals = new Map<string, number>()
    let last = 0
    const callback = (info: ProgressInfo): void => {
      const name = info.name ?? label
      if (info.status === 'progress' && info.file) {
        if (typeof info.total === 'number' && info.total > 0) totals.set(info.file, info.total)
        const now = performance.now()
        if (now - last < 100 && (info.progress ?? 0) < 100) return
        last = now
        const percent = Math.max(0, Math.min(100, info.progress ?? 0))
        deps.status({
          kind: 'download',
          text: `Loading ${name}: ${info.file} ${Math.round(percent)}%`,
          progress: percent / 100,
        })
      } else if (info.status === 'initiate' && info.file) {
        deps.status({ kind: 'download', text: `Loading ${name}: ${info.file}` })
      } else if (info.status === 'ready') {
        deps.status({ kind: 'running', text: 'Running' })
      }
    }
    const bytes = (): number => {
      let sum = 0
      for (const total of totals.values()) sum += total
      return sum
    }
    return { callback, bytes }
  }

  function resolveDevice(wanted: unknown): 'webgpu' | 'wasm' {
    if (wanted === 'webgpu' || wanted === 'wasm') return wanted
    if (wanted === 'auto' || wanted === null || wanted === undefined) return device.webgpu ? 'webgpu' : 'wasm'
    throw new NamedError('ValueError', `device must be "auto", "webgpu" or "wasm", not ${JSON.stringify(wanted)}`)
  }

  function loadFailure(what: string, err: unknown): NamedError {
    if (err instanceof NamedError) return err
    const message = String((err as Error)?.message ?? err)
    return new NamedError('LabError', `Could not load ${what}: ${message}`)
  }

  /**
   * Load something on the wanted device. With device "auto", a failure on the graphics card (an
   * unsupported operator, not enough memory) is retried once on the CPU, with a warning.
   */
  async function onDevice<T>(wanted: unknown, what: string, load: (device: 'webgpu' | 'wasm') => Promise<T>): Promise<{ value: T; device: string }> {
    const first = resolveDevice(wanted)
    try {
      return { value: await load(first), device: first }
    } catch (err) {
      const auto = wanted === 'auto' || wanted === null || wanted === undefined
      if (!(auto && first === 'webgpu')) throw loadFailure(what, err)
      stream('stderr', `lab: ${what} did not load on the graphics card (${String((err as Error)?.message ?? err)}). Trying the CPU.\n`)
      try {
        return { value: await load('wasm'), device: 'wasm' }
      } catch (second) {
        throw loadFailure(what, second)
      }
    }
  }

  async function createPipeline(p: Record<string, unknown>): Promise<Record<string, unknown>> {
    const task = String(p.task)
    const model = typeof p.model === 'string' ? p.model : undefined
    const dtype = dtypeOption(p.dtype)
    const requested = p.device ?? 'auto'
    const keyFor = (dev: unknown) => JSON.stringify([task, model ?? null, dev, dtype ?? null])
    const key = keyFor(requested)
    let loading = pipelines.get(key)
    if (!loading) {
      loading = (async () => {
        const T = await loadTransformers()
        const label = model ?? `the default ${task} model`
        const tracker = progressTracker(label)
        const started = performance.now()
        const { value: run, device: actual } = await onDevice(requested, label, (dev) =>
          T.pipeline(task, model, {
            ...((p.options as Record<string, unknown>) ?? {}),
            device: dev,
            ...(dtype ? { dtype } : {}),
            progress_callback: tracker.callback,
          }),
        )
        const bytes = tracker.bytes()
        const loaded: LoadedPipeline = {
          id: nextId++,
          run,
          info: {
            task,
            model: model ?? '(default)',
            device: actual,
            dtype: dtype ?? null,
            size_mb: bytes > 0 ? megabytes(bytes) : null,
            load_seconds: Math.round((performance.now() - started) / 100) / 10,
          },
        }
        loaded.info.id = loaded.id
        pipelinesById.set(loaded.id, loaded)
        // The same pipeline answers for "auto" and for the device it ended up on.
        pipelines.set(keyFor(actual), Promise.resolve(loaded))
        return loaded
      })()
      pipelines.set(key, loading)
      loading.catch(() => pipelines.delete(key))
    }
    const loaded = await loading
    deps.status({ kind: 'running', text: 'Running' })
    return loaded.info
  }

  async function callPipeline(p: Record<string, unknown>): Promise<unknown> {
    const loaded = pipelinesById.get(p.id as number)
    if (!loaded) throw new NamedError('LabError', 'This pipeline belongs to an earlier runtime. Run the cell that creates it again.')
    const inputs = (p.inputs as unknown[]) ?? []
    const options = (p.options as Record<string, unknown>) ?? {}
    deps.status({ kind: 'running', text: `Running ${String(loaded.info.model)} on ${String(loaded.info.device)}` })
    try {
      return await loaded.run(...inputs, options)
    } catch (err) {
      throw new NamedError('LabError', `The model failed: ${String((err as Error)?.message ?? err)}`)
    } finally {
      deps.status({ kind: 'running', text: 'Running' })
    }
  }

  function loadTokenizer(model: string): Promise<{ id: number; tokenizer: TokenizerLike }> {
    let loading = tokenizers.get(model)
    if (!loading) {
      loading = (async () => {
        const T = await loadTransformers()
        const tracker = progressTracker(model)
        try {
          const tokenizer = await T.AutoTokenizer.from_pretrained(model, { progress_callback: tracker.callback })
          const entry = { id: nextId++, tokenizer }
          tokenizersById.set(entry.id, tokenizer)
          return entry
        } catch (err) {
          throw loadFailure(`the tokenizer of ${model}`, err)
        }
      })()
      tokenizers.set(model, loading)
      loading.catch(() => tokenizers.delete(model))
    }
    return loading
  }

  function tokenizerById(id: unknown): TokenizerLike {
    const tokenizer = tokenizersById.get(id as number)
    if (!tokenizer) throw new NamedError('LabError', 'This tokenizer belongs to an earlier runtime. Run the cell that creates it again.')
    return tokenizer
  }

  /** Logits of a causal language model at the last position of `text`. */
  async function lastLogits(p: Record<string, unknown>): Promise<{ logits: Float32Array; tokenizer: TokenizerLike }> {
    const model = String(p.model)
    const text = String(p.text ?? '')
    const dtype = dtypeOption(p.dtype)
    const requested = p.device ?? 'auto'
    const { tokenizer } = await loadTokenizer(model)
    if (tokenizer.encode(text).length === 0) {
      throw new NamedError('ValueError', 'The text is empty after tokenization: give the model at least one token to continue.')
    }
    const key = JSON.stringify([model, requested, dtype ?? null])
    let loading = languageModels.get(key)
    if (!loading) {
      loading = (async () => {
        const T = await loadTransformers()
        const tracker = progressTracker(model)
        const { value, device: actual } = await onDevice(requested, model, (dev) =>
          T.AutoModelForCausalLM.from_pretrained(model, {
            device: dev,
            ...(dtype ? { dtype } : {}),
            progress_callback: tracker.callback,
          }),
        )
        return { model: value, device: actual }
      })()
      languageModels.set(key, loading)
      loading.catch(() => languageModels.delete(key))
    }
    const lm = await loading
    deps.status({ kind: 'running', text: `Running ${model} on ${lm.device}` })
    let logits: TensorLike
    try {
      const inputs = await tokenizer(text)
      logits = (await lm.model(inputs)).logits
    } catch (err) {
      throw new NamedError('LabError', `The model failed: ${String((err as Error)?.message ?? err)}`)
    } finally {
      deps.status({ kind: 'running', text: 'Running' })
    }
    // Shape (batch, positions, vocabulary): keep the last position of the first sequence.
    const dims = logits.dims
    const data = logits.data as unknown as ArrayLike<number> & { subarray?: (a: number, b: number) => ArrayLike<number> }
    if (dims.length !== 3 || dims[0] < 1 || !ArrayBuffer.isView(logits.data)) {
      throw new NamedError('LabError', `Unexpected logits shape [${dims.join(', ')}] from ${model}`)
    }
    const [, positions, vocabulary] = dims
    const start = (positions - 1) * vocabulary
    const last = new Float32Array(vocabulary)
    for (let i = 0; i < vocabulary; i++) last[i] = Number(data[start + i])
    return { logits: last, tokenizer }
  }

  async function nextTokenProbabilities(p: Record<string, unknown>): Promise<unknown> {
    const { logits, tokenizer } = await lastLogits(p)
    const k = Math.max(1, Math.min(logits.length, Number(p.top_k ?? 10)))
    // Softmax in double precision, shifted by the maximum so that exp() cannot overflow.
    let max = -Infinity
    for (const x of logits) if (x > max) max = x
    let sum = 0
    const exps = new Float64Array(logits.length)
    for (let i = 0; i < logits.length; i++) {
      exps[i] = Math.exp(logits[i] - max)
      sum += exps[i]
    }
    const order = Array.from(exps.keys()).sort((a, b) => exps[b] - exps[a]).slice(0, k)
    return {
      top: order.map((id) => ({ id, token: tokenizer.decode([id]), probability: exps[id] / sum })),
    }
  }

  async function loadAudio(p: Record<string, unknown>): Promise<unknown> {
    const sr = Number(p.sr ?? 16000)
    let bytes: ArrayBuffer
    if (typeof p.url === 'string') {
      deps.status({ kind: 'download', text: `Downloading ${p.url}` })
      let response: Response
      try {
        response = await fetch(p.url)
      } catch (err) {
        throw new NamedError('LabError', `Could not download ${p.url}: ${String((err as Error)?.message ?? err)}`)
      }
      if (!response.ok) throw new NamedError('LabError', `Could not download ${p.url}: the server answered ${response.status}`)
      bytes = await response.arrayBuffer()
    } else if (ArrayBuffer.isView(p.data)) {
      const view = p.data
      bytes = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
    } else {
      throw new NamedError('TypeError', 'lab.load_audio needs an address or the bytes of an audio file')
    }
    deps.status({ kind: 'running', text: 'Decoding audio' })
    const result = (await deps.host('audio.decode', { bytes, sr }, [bytes])) as { samples: Float32Array; sr: number }
    deps.status({ kind: 'running', text: 'Running' })
    return result
  }

  async function record(p: Record<string, unknown>): Promise<unknown> {
    deps.status({ kind: 'running', text: 'Waiting for the microphone' })
    try {
      return await deps.host('audio.record', { seconds: Number(p.seconds), sr: Number(p.sr ?? 16000) })
    } finally {
      deps.status({ kind: 'running', text: 'Running' })
    }
  }

  async function tokenDialog(): Promise<unknown> {
    const result = (await deps.host('token.dialog', {})) as { set: boolean }
    tokenSet = result.set
    return result
  }

  function inference(kind: string) {
    return async (p: Record<string, unknown>): Promise<unknown> => {
      deps.status({ kind: 'running', text: `Asking Hugging Face (${String(p.model)})` })
      try {
        const params: Record<string, unknown> = { ...p, kind }
        const transfer: Transferable[] = []
        if (ArrayBuffer.isView(p.data)) {
          const view = p.data
          const copy = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
          params.data = copy
          transfer.push(copy)
        }
        return await deps.host('inference', params, transfer)
      } finally {
        deps.status({ kind: 'running', text: 'Running' })
      }
    }
  }

  const asyncMethods: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {
    'pipeline.create': createPipeline,
    'pipeline.call': callPipeline,
    'tokenizer.load': async (p) => ({ id: (await loadTokenizer(String(p.model))).id, model: String(p.model) }),
    'lm.logits': async (p) => ({ logits: (await lastLogits(p)).logits }),
    'lm.probs': nextTokenProbabilities,
    'audio.load': loadAudio,
    'audio.record': record,
    'token.dialog': tokenDialog,
    'inference.chat': inference('chat'),
    'inference.text_to_image': inference('text_to_image'),
    'inference.asr': inference('asr'),
  }

  const syncMethods: Record<string, (p: Record<string, unknown>) => unknown> = {
    device: () => ({ ...device, ...deps.runtime }),
    'token.status': () => ({ set: tokenSet }),
    'tokenizer.encode': (p) => Array.from(tokenizerById(p.id).encode(String(p.text)), Number),
    'tokenizer.decode': (p) => tokenizerById(p.id).decode(p.ids as number[], { skip_special_tokens: false }),
    'tokenizer.tokens': (p) => tokenizerById(p.id).tokenize(String(p.text)),
  }

  /** Only the model calls need tensors, so only they wait for the library before reading arguments. */
  async function tensorClass(method: string): Promise<Pick<TransformersModule, 'Tensor'> | undefined> {
    return method === 'pipeline.call' ? await loadTransformers() : undefined
  }

  return {
    /** Called from Python: `await _lab_js.call(method, json, buffers)`. */
    async call(method: string, json: string, buffers: ArrayLike<ArrayBufferView>): Promise<Wire> {
      const fn = asyncMethods[method]
      if (!fn) throw new NamedError('LabError', `lab: unknown bridge method ${method}`)
      flush()
      const params = fromWire(json, buffers, await tensorClass(method)) as Record<string, unknown>
      const wire = await toWire(await fn(params))
      if (wire.arrays > 0) await deps.ensureNumpy()
      return { json: wire.json, buffers: wire.buffers }
    },
    /** Called from Python for things that answer at once. */
    call_sync(method: string, json: string, buffers: ArrayLike<ArrayBufferView>): Wire {
      const fn = syncMethods[method]
      if (!fn) throw new NamedError('LabError', `lab: unknown bridge method ${method}`)
      const result = fn(fromWire(json, buffers) as Record<string, unknown>)
      // No binary values on this path: everything here is plain JSON.
      return { json: JSON.stringify(result ?? null), buffers: [] }
    },
    /** One output for the running cell, as JSON in nbformat's shape. */
    emit(json: string): void {
      flush()
      deps.display(JSON.parse(json) as DisplayOutput)
    },
    stream,
    flush,
    /** The page tells the worker when the token was set or removed with the toolbar button. */
    setTokenState(set: boolean): void {
      tokenSet = set
    },
  }
}

export type Bridge = ReturnType<typeof createBridge>
