/**
 * What the worker cannot do itself, done by the page:
 *
 * - decoding audio (workers have no audio decoder) and recording from the microphone;
 * - the token dialog;
 * - requests to models hosted by Hugging Face. These are made here, and not in the worker, so that
 *   the code of a notebook never holds the student's token: it can ask for a chat reply, an image
 *   or a transcript, and gets back only the answer. Only fixed option names are passed on, so a
 *   notebook cannot point the client (and with it the token) at another server.
 */
import { config } from '../config.ts'
import { redactText } from '../notebook/ipynb.ts'
import { openTokenDialog, recordWithDialog } from '../ui/dialogs.ts'
import { NamedError, type HostMethod } from './protocol.ts'
import { getToken, secrets } from './token.ts'

interface Answer {
  result: unknown
  transfer: Transferable[]
}

// --- Audio --------------------------------------------------------------------------------------

/** Decode any audio file the browser understands to mono float32 at `sr` samples per second. */
export async function decodeAudio(bytes: ArrayBuffer, sr: number): Promise<Float32Array> {
  if (!Number.isFinite(sr) || sr < 3000 || sr > 192000) {
    throw new NamedError('ValueError', `The sample rate must be between 3000 and 192000, not ${sr}`)
  }
  // Decoding in a context with the wanted rate also resamples.
  const context = new OfflineAudioContext(1, 1, sr)
  let buffer: AudioBuffer
  try {
    buffer = await context.decodeAudioData(bytes)
  } catch {
    throw new NamedError('LabError', 'The browser could not decode this audio. Try a wav, mp3, ogg or flac file.')
  }
  const mono = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels
  }
  return mono
}

async function audioDecode(params: { bytes: ArrayBuffer; sr: number }): Promise<Answer> {
  const samples = await decodeAudio(params.bytes, params.sr)
  return { result: { samples, sr: params.sr }, transfer: [samples.buffer] }
}

async function audioRecord(params: { seconds: number; sr: number }): Promise<Answer> {
  let blob: Blob
  try {
    blob = await recordWithDialog(params.seconds)
  } catch (err) {
    throw new NamedError((err as Error).name === 'PermissionError' ? 'PermissionError' : 'LabError', (err as Error).message)
  }
  const samples = await decodeAudio(await blob.arrayBuffer(), params.sr)
  return { result: { samples, sr: params.sr }, transfer: [samples.buffer] }
}

// --- Hosted models ------------------------------------------------------------------------------

interface InferenceClientLike {
  chatCompletion(args: Record<string, unknown>): Promise<Record<string, unknown>>
  textToImage(args: Record<string, unknown>, options?: Record<string, unknown>): Promise<Blob | string>
  automaticSpeechRecognition(args: Record<string, unknown>): Promise<Record<string, unknown>>
}

interface InferenceModule {
  InferenceClient: new (token: string) => InferenceClientLike
}

let inferenceModule: Promise<InferenceModule> | null = null

function loadInferenceModule(): Promise<InferenceModule> {
  if (!inferenceModule) {
    inferenceModule = (import(/* @vite-ignore */ new URL(config.hfInferenceUrl, location.href).href) as Promise<InferenceModule>).catch(
      (err: unknown) => {
        inferenceModule = null
        throw new NamedError(
          'LabError',
          `Could not load the Hugging Face client from ${config.hfInferenceUrl}. Check your internet connection. (${String(
            (err as Error)?.message ?? err,
          )})`,
        )
      },
    )
  }
  return inferenceModule
}

const CHAT_OPTIONS = ['max_tokens', 'temperature', 'top_p', 'seed', 'stop', 'frequency_penalty', 'presence_penalty']
const IMAGE_OPTIONS = ['negative_prompt', 'width', 'height', 'num_inference_steps', 'guidance_scale', 'seed']

function pick(options: unknown, allowed: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (options && typeof options === 'object') {
    for (const key of allowed) {
      const value = (options as Record<string, unknown>)[key]
      if (value !== undefined && value !== null) out[key] = value
    }
  }
  return out
}

function modelId(value: unknown): string {
  // "organisation/name", optionally with ":provider" or ":policy" as Hugging Face allows. Never an address.
  if (typeof value !== 'string' || !/^[\w.-]+(\/[\w.-]+)?(:[\w.-]+)?$/.test(value)) {
    throw new NamedError('ValueError', 'model must be a Hugging Face model id such as "organisation/model-name"')
  }
  return value
}

function providerOf(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'string' || !/^[a-z0-9-]+$/.test(value)) {
    throw new NamedError('ValueError', 'provider must be the name of an inference provider, for example "hf-inference"')
  }
  return { provider: value }
}

async function inference(params: Record<string, unknown>): Promise<Answer> {
  const token = getToken()
  if (!token) {
    throw new NamedError(
      'LabError',
      'No Hugging Face token is set. Press “HF token” at the top of the page (or run `await lab.set_hf_token()`), paste your token, and run the cell again.',
    )
  }
  const model = modelId(params.model)
  const provider = providerOf(params.provider)
  const { InferenceClient } = await loadInferenceModule()
  const client = new InferenceClient(token)
  try {
    switch (params.kind) {
      case 'chat': {
        const messages = Array.isArray(params.messages) ? params.messages : []
        const response = await client.chatCompletion({
          model,
          messages: messages.map((m: { role?: unknown; content?: unknown }) => ({ role: String(m.role), content: String(m.content) })),
          ...pick(params.options, CHAT_OPTIONS),
          ...provider,
        })
        const clean = JSON.parse(redactText(JSON.stringify(response ?? {}), [token])) as {
          choices?: Array<{ message?: { content?: unknown } }>
        }
        const content = clean.choices?.[0]?.message?.content
        return { result: { text: typeof content === 'string' ? content : '', response: clean }, transfer: [] }
      }
      case 'text_to_image': {
        const image = await client.textToImage(
          { model, inputs: String(params.prompt ?? ''), parameters: pick(params.options, IMAGE_OPTIONS), ...provider },
          { outputType: 'blob' },
        )
        if (!(image instanceof Blob)) throw new Error('the client did not return an image')
        const data = await image.arrayBuffer()
        return { result: { data, mime: image.type.startsWith('image/') ? image.type : '' }, transfer: [data] }
      }
      case 'asr': {
        if (!(params.data instanceof ArrayBuffer)) throw new NamedError('TypeError', 'lab.inference.asr needs audio')
        const response = await client.automaticSpeechRecognition({
          model,
          data: new Blob([params.data], { type: 'audio/wav' }),
          ...provider,
        })
        return { result: { text: redactText(String(response?.text ?? ''), [token]) }, transfer: [] }
      }
      default:
        throw new NamedError('LabError', 'lab: unknown inference request')
    }
  } catch (err) {
    if (err instanceof NamedError) throw err
    const message = redactText(String((err as Error)?.message ?? err), secrets())
    throw new NamedError('LabError', `The request to Hugging Face failed: ${message}`)
  }
}

export async function answerHostRequest(method: HostMethod, params: unknown): Promise<Answer> {
  switch (method) {
    case 'audio.decode':
      return audioDecode(params as { bytes: ArrayBuffer; sr: number })
    case 'audio.record':
      return audioRecord(params as { seconds: number; sr: number })
    case 'token.dialog':
      return { result: { set: await openTokenDialog() }, transfer: [] }
    case 'inference':
      return inference(params as Record<string, unknown>)
  }
}
