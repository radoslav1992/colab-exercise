/**
 * Making a notebook small enough for the server (shared/limits.ts: about 1 MB).
 *
 * When the notebook is too large, the largest binary outputs go first: images, sound and video,
 * also when they are embedded in an HTML output as `data:` addresses (which is how `lab.play`
 * shows a player). Each one is replaced by a line of text that says what was left out. Code,
 * Markdown and text outputs are never dropped: if the notebook is still too large without its
 * binary outputs, `fits` is false and the caller says so.
 *
 * The notebook in memory is not changed: the copy in this browser and the downloaded file keep
 * every output.
 */
import { redactText, toIpynbObject, type JsonObject, type Notebook } from './ipynb.ts'

export interface DroppedOutput {
  /** Position of the cell in the notebook, counted from 1. */
  cell: number
  /** "image", "sound" or "video". */
  kind: string
  bytes: number
}

export interface FitResult {
  /** The notebook as compact JSON. */
  text: string
  bytes: number
  fits: boolean
  dropped: DroppedOutput[]
}

const encoder = new TextEncoder()
const EMBEDDED_MEDIA = /data:(image|audio|video)\/[\w.+-]+;base64,/
/** An HTML output counts as binary when it embeds media and is larger than this. */
const MIN_EMBEDDED = 20_000

function kindOf(mime: string, value: string): string | null {
  if (mime === 'image/svg+xml') return null
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'sound'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'text/html' && value.length > MIN_EMBEDDED) {
    const match = EMBEDDED_MEDIA.exec(value)
    if (match) return match[1] === 'audio' ? 'sound' : match[1]
  }
  return null
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value.join('')
  return null
}

interface Candidate {
  cell: number
  data: JsonObject
  mime: string
  kind: string
  bytes: number
}

export function describeSize(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_000))} kB`
}

/** Serialize `notebook` as compact JSON of at most `maxBytes` UTF-8 bytes, dropping binary outputs if needed. */
export function fitNotebook(notebook: Notebook, maxBytes: number, redact: string[] = []): FitResult {
  const object = toIpynbObject(notebook)
  const serialize = () => redactText(JSON.stringify(object), redact)
  let text = serialize()
  let bytes = encoder.encode(text).length
  if (bytes <= maxBytes) return { text, bytes, fits: true, dropped: [] }

  const candidates: Candidate[] = []
  ;(object.cells as JsonObject[]).forEach((cell, index) => {
    if (!Array.isArray(cell.outputs)) return
    for (const output of cell.outputs as JsonObject[]) {
      if (output.output_type !== 'display_data' && output.output_type !== 'execute_result') continue
      const data = output.data as JsonObject | undefined
      if (!data || typeof data !== 'object') continue
      for (const [mime, value] of Object.entries(data)) {
        const content = textOf(value)
        const kind = content === null ? null : kindOf(mime, content)
        if (content !== null && kind) candidates.push({ cell: index + 1, data, mime, kind, bytes: content.length })
      }
    }
  })
  candidates.sort((a, b) => b.bytes - a.bytes)

  const dropped: DroppedOutput[] = []
  for (const candidate of candidates) {
    if (bytes <= maxBytes) break
    delete candidate.data[candidate.mime]
    const note = `[${candidate.kind} output of ${describeSize(candidate.bytes)} was not saved on the server: a stored notebook is limited to ${describeSize(maxBytes)}. Run the cell to make it again.]`
    const plain = textOf(candidate.data['text/plain'])
    candidate.data['text/plain'] = plain ? `${plain}\n${note}` : note
    dropped.push({ cell: candidate.cell, kind: candidate.kind, bytes: candidate.bytes })
    // An estimate while dropping; the exact size is measured below.
    bytes -= candidate.bytes
  }
  text = serialize()
  bytes = encoder.encode(text).length
  return { text, bytes, fits: bytes <= maxBytes, dropped }
}

/** "the image of cell 3 (1.2 MB), the sound of cell 7 (2.3 MB)". */
export function describeDropped(dropped: DroppedOutput[]): string {
  return dropped.map((d) => `the ${d.kind} of cell ${d.cell} (${describeSize(d.bytes)})`).join(', ')
}
