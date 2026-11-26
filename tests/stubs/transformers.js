/**
 * A stand-in for @huggingface/transformers, used by the end-to-end tests (.env.e2e points the app
 * here). It has the same surface that src/runtime/bridge.ts uses and returns values of the same
 * shapes as the real library (tensors as { data: TypedArray, dims }, audio as
 * { audio: Float32Array, sampling_rate }, progress events), but no model: every result is computed
 * from the input so that tests can predict it.
 */
export const env = { allowLocalModels: true }

export class Tensor {
  constructor(type, data, dims) {
    this.type = type
    this.data = data
    this.dims = dims
  }
}

const log = (globalThis.__stubLog ??= { pipelines: [], tokenizers: [], models: [], calls: [] })

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function fakeDownload(name, files, progress_callback) {
  for (const [file, total] of files) {
    progress_callback?.({ status: 'initiate', name, file })
    progress_callback?.({ status: 'download', name, file })
    for (const fraction of [0.25, 0.5, 1]) {
      await tick()
      progress_callback?.({ status: 'progress', name, file, progress: fraction * 100, loaded: total * fraction, total })
    }
    progress_callback?.({ status: 'done', name, file })
  }
  progress_callback?.({ status: 'ready', task: 'stub', model: name })
}

function describe(value) {
  if (value instanceof Tensor) return { kind: 'Tensor', type: value.type, dims: value.dims, ctor: value.data.constructor.name, first: Number(value.data[0]) }
  if (ArrayBuffer.isView(value)) return { kind: value.constructor.name, length: value.length, first: Number(value[0]) }
  if (Array.isArray(value)) return value.map(describe)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, describe(v)]))
  return value
}

export async function pipeline(task, model, options = {}) {
  const { progress_callback, ...rest } = options
  log.pipelines.push({ task, model: model ?? null, ...rest })
  if (model === 'stub/missing') throw new Error('Could not locate file: "https://huggingface.co/stub/missing/resolve/main/config.json".')
  if (model === 'stub/cpu-only' && options.device === 'webgpu') throw new Error('no available backend found: webgpu')
  await fakeDownload(model ?? `default-${task}`, [['config.json', 1000], ['onnx/model.onnx', 3_000_000]], progress_callback)
  const record = (args) => log.calls.push({ task, model: model ?? null, args: describe(args) })
  switch (task) {
    case 'automatic-speech-recognition':
      return async (audio, opts = {}) => {
        record([audio, opts])
        if (!(audio instanceof Float32Array) && !(audio instanceof Float64Array)) throw new Error('audio must be a Float32Array')
        const seconds = audio.length / 16000
        const out = { text: ` heard ${audio.length} samples` }
        if (opts.return_timestamps) out.chunks = [{ timestamp: [0, seconds / 2], text: ' heard' }, { timestamp: [seconds / 2, seconds], text: ` ${audio.length} samples` }]
        return out
      }
    case 'text-to-speech':
      return async (text, opts = {}) => {
        record([text, opts])
        const n = 1600 * String(text).length
        const audio = new Float32Array(n)
        for (let i = 0; i < n; i++) audio[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 16000)
        return { audio, sampling_rate: 16000 }
      }
    case 'feature-extraction':
      return async (text, opts = {}) => {
        record([text, opts])
        return new Tensor('float32', Float32Array.from({ length: 12 }, (_, i) => i / 2), [1, 3, 4])
      }
    case 'text-generation':
      return async (prompt, opts = {}) => {
        record([prompt, opts])
        return [{ generated_text: `${prompt} and so on (max_new_tokens=${opts.max_new_tokens ?? 'default'})` }]
      }
    case 'image-segmentation':
      return async (input, opts = {}) => {
        record([input, opts])
        return [{ label: 'thing', score: 0.75, mask: { data: new Uint8ClampedArray([0, 255, 255, 0, 255, 0]), width: 3, height: 2, channels: 1 } }]
      }
    case 'echo':
      // Not a real task: returns a description of what arrived, to test Python -> JavaScript conversion.
      return async (...args) => {
        record(args)
        return { received: describe(args), big: 12n, nothing: null, ids: new BigInt64Array([1n, 2n, 3n]) }
      }
    case 'fail':
      return async () => {
        throw new Error('the session ran out of memory')
      }
    default:
      throw new Error(`Unsupported pipeline: ${task}. Must be one of [...]`)
  }
}

// A toy tokenizer: words with a leading "Ġ" for the space before them (as GPT-2 spells it).
const BASE_VOCAB = ['Ġthe', 'Ġcat', 'Ġsat', 'Ġon', 'Ġmat', '.', 'Ġa', 'Ġdog']

class StubTokenizer {
  constructor() {
    this.vocab = [...BASE_VOCAB]
  }
  tokenize(text) {
    const pieces = String(text).match(/\s*[A-Za-z0-9']+|\s*[^\sA-Za-z0-9']/g) ?? []
    return pieces.map((piece) => (/^\s/.test(piece) ? `Ġ${piece.trim()}` : piece))
  }
  encode(text) {
    return this.tokenize(text).map((token) => {
      let id = this.vocab.indexOf(token)
      if (id < 0) {
        this.vocab.push(token)
        id = this.vocab.length - 1
      }
      return id
    })
  }
  decode(ids) {
    return ids.map((id) => (this.vocab[id] ?? '<unk>').replace(/^Ġ/, ' ')).join('')
  }
}

export const AutoTokenizer = {
  async from_pretrained(model, options = {}) {
    log.tokenizers.push(model)
    if (model === 'stub/missing') throw new Error('Could not locate file: "https://huggingface.co/stub/missing/resolve/main/tokenizer.json".')
    await fakeDownload(model, [['tokenizer.json', 2000]], options.progress_callback)
    const tokenizer = new StubTokenizer()
    const call = (text) => {
      const ids = tokenizer.encode(text)
      return {
        input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
        attention_mask: new Tensor('int64', BigInt64Array.from(ids, () => 1n), [1, ids.length]),
      }
    }
    call.encode = (text) => tokenizer.encode(text)
    call.decode = (ids) => tokenizer.decode(ids)
    call.tokenize = (text) => tokenizer.tokenize(text)
    return call
  },
}

/** Vocabulary of 8 tokens; the logit of token v after n input tokens is v / 2, plus 3 for v === n % 8. */
export const STUB_VOCAB_SIZE = 8

export const AutoModelForCausalLM = {
  async from_pretrained(model, options = {}) {
    const { progress_callback, ...rest } = options
    log.models.push({ model, ...rest })
    await fakeDownload(model, [['onnx/model.onnx', 5_000_000]], progress_callback)
    return async (inputs) => {
      const n = inputs.input_ids.dims[1]
      const data = new Float32Array(n * STUB_VOCAB_SIZE)
      for (let position = 0; position < n; position++) {
        for (let v = 0; v < STUB_VOCAB_SIZE; v++) {
          data[position * STUB_VOCAB_SIZE + v] = v / 2 + (v === (position + 1) % STUB_VOCAB_SIZE ? 3 : 0)
        }
      }
      return { logits: new Tensor('float32', data, [1, n, STUB_VOCAB_SIZE]) }
    }
  },
}
