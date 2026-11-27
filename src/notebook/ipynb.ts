/**
 * Reading and writing `.ipynb` files (nbformat 4).
 *
 * In memory, text is kept as plain strings (a cell's source, a stream's text, text MIME values).
 * On disk it is written the way Jupyter writes it: lists of lines. Anything this app does not
 * understand (notebook and cell metadata, attachments, unknown output types and fields) is kept
 * and written back unchanged, so a notebook survives a round trip through the app.
 */

export type JsonObject = Record<string, unknown>

export interface StreamOutput {
  output_type: 'stream'
  name: 'stdout' | 'stderr'
  text: string
}

export interface DisplayOutput {
  output_type: 'display_data' | 'execute_result'
  /** MIME type to value. Text types are strings, JSON types are kept as parsed JSON. */
  data: Record<string, unknown>
  metadata: JsonObject
  execution_count?: number | null
}

export interface ErrorOutput {
  output_type: 'error'
  ename: string
  evalue: string
  traceback: string[]
}

/** An output type this app does not know. It is kept as it was and shown as plain JSON. */
export interface UnknownOutput {
  output_type: string
  [key: string]: unknown
}

export type Output = StreamOutput | DisplayOutput | ErrorOutput | UnknownOutput

export type CellType = 'code' | 'markdown' | 'raw'

export interface Cell {
  id: string
  cell_type: CellType
  source: string
  metadata: JsonObject
  /** Code cells only. */
  outputs: Output[]
  /** Code cells only. */
  execution_count: number | null
  /** Other keys of the cell object, for example `attachments`. Written back unchanged. */
  extra: JsonObject
}

export interface Notebook {
  cells: Cell[]
  metadata: JsonObject
  /** The minor version the file had when it was opened. Written as at least 5 (cell ids). */
  nbformat_minor: number
  /** Other top-level keys. Written back unchanged. */
  extra: JsonObject
}

export class NotebookFormatError extends Error {}

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export function newCellId(taken?: Set<string>): string {
  for (;;) {
    const bytes = new Uint8Array(6)
    crypto.getRandomValues(bytes)
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    if (!taken || !taken.has(id)) return id
  }
}

export function newCell(cell_type: CellType, source = '', taken?: Set<string>): Cell {
  return { id: newCellId(taken), cell_type, source, metadata: {}, outputs: [], execution_count: null, extra: {} }
}

export function emptyNotebook(): Notebook {
  return {
    cells: [newCell('code')],
    metadata: defaultMetadata({}),
    nbformat_minor: 5,
    extra: {},
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** nbformat's "multiline string": a string or a list of strings that are joined without a separator. */
function joinText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => (typeof part === 'string' ? part : String(part))).join('')
  return value == null ? '' : String(value)
}

/** Split into lines that keep their line ending, the way Jupyter stores text. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  const out = lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line))
  if (out[out.length - 1] === '') out.pop()
  return out
}

function isJsonMime(mime: string): boolean {
  return mime === 'application/json' || mime.endsWith('+json')
}

function parseOutput(raw: unknown): Output | null {
  if (!isObject(raw) || typeof raw.output_type !== 'string') return null
  switch (raw.output_type) {
    case 'stream':
      return { ...raw, output_type: 'stream', name: raw.name === 'stderr' ? 'stderr' : 'stdout', text: joinText(raw.text) }
    case 'display_data':
    case 'execute_result': {
      const data: Record<string, unknown> = {}
      if (isObject(raw.data)) {
        for (const [mime, value] of Object.entries(raw.data)) {
          data[mime] = isJsonMime(mime) ? value : joinText(value)
        }
      }
      return { ...raw, output_type: raw.output_type, data, metadata: isObject(raw.metadata) ? raw.metadata : {} }
    }
    case 'error':
      return {
        ...raw,
        output_type: 'error',
        ename: joinText(raw.ename),
        evalue: joinText(raw.evalue),
        traceback: Array.isArray(raw.traceback) ? raw.traceback.map((line) => String(line)) : [],
      }
    default:
      return raw as UnknownOutput
  }
}

function parseCell(raw: unknown, taken: Set<string>): Cell | null {
  if (!isObject(raw)) return null
  const { id, cell_type, source, metadata, outputs, execution_count, ...extra } = raw
  const type: CellType = cell_type === 'code' || cell_type === 'markdown' ? cell_type : 'raw'
  const cellId = typeof id === 'string' && ID_PATTERN.test(id) && !taken.has(id) ? id : newCellId(taken)
  taken.add(cellId)
  const cell: Cell = {
    id: cellId,
    cell_type: type,
    source: joinText(source),
    metadata: isObject(metadata) ? metadata : {},
    outputs: [],
    execution_count: null,
    extra,
  }
  if (type === 'code') {
    if (Array.isArray(outputs)) {
      for (const output of outputs) {
        const parsed = parseOutput(output)
        if (parsed) cell.outputs.push(parsed)
      }
    }
    cell.execution_count = typeof execution_count === 'number' ? execution_count : null
  }
  return cell
}

/** Parse the text of an `.ipynb` file. Throws NotebookFormatError with a message a student can act on. */
export function parseNotebook(text: string): Notebook {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new NotebookFormatError('This file is not valid JSON, so it is not a Jupyter notebook.')
  }
  return notebookFromObject(raw)
}

/** The same for a notebook that is already parsed JSON (as the server sends it). It is checked just like a file. */
export function notebookFromObject(raw: unknown): Notebook {
  if (!isObject(raw)) throw new NotebookFormatError('This file is not a Jupyter notebook.')
  const { cells, metadata, nbformat, nbformat_minor, ...extra } = raw
  if (typeof nbformat === 'number' && nbformat < 4) {
    throw new NotebookFormatError(
      `This notebook uses the old format (nbformat ${nbformat}). Open it in Jupyter and save it again to convert it.`,
    )
  }
  if (nbformat !== 4 || !Array.isArray(cells)) {
    throw new NotebookFormatError('This file is not a Jupyter notebook (expected nbformat 4 and a list of cells).')
  }
  const taken = new Set<string>()
  const parsedCells: Cell[] = []
  for (const cell of cells) {
    const parsed = parseCell(cell, taken)
    if (parsed) parsedCells.push(parsed)
  }
  return {
    cells: parsedCells,
    metadata: isObject(metadata) ? metadata : {},
    nbformat_minor: typeof nbformat_minor === 'number' ? nbformat_minor : 0,
    extra,
  }
}

function defaultMetadata(metadata: JsonObject): JsonObject {
  return {
    ...metadata,
    kernelspec: isObject(metadata.kernelspec)
      ? metadata.kernelspec
      : { display_name: 'Python 3', language: 'python', name: 'python3' },
    language_info: isObject(metadata.language_info) ? metadata.language_info : { name: 'python' },
  }
}

function serializeOutput(output: Output): JsonObject {
  switch (output.output_type) {
    case 'stream': {
      const stream = output as StreamOutput
      return { ...stream, text: splitLines(stream.text) }
    }
    case 'display_data':
    case 'execute_result': {
      const display = output as DisplayOutput
      const data: JsonObject = {}
      for (const [mime, value] of Object.entries(display.data)) {
        data[mime] = typeof value === 'string' && !isJsonMime(mime) ? splitLines(value) : value
      }
      const out: JsonObject = { ...display, data, metadata: display.metadata }
      if (display.output_type === 'execute_result') out.execution_count = display.execution_count ?? null
      else delete out.execution_count
      return out
    }
    default:
      return { ...output }
  }
}

function serializeCell(cell: Cell): JsonObject {
  const base: JsonObject = {
    ...cell.extra,
    cell_type: cell.cell_type,
    id: cell.id,
    metadata: cell.metadata,
    source: splitLines(cell.source),
  }
  if (cell.cell_type === 'code') {
    base.execution_count = cell.execution_count
    base.outputs = cell.outputs.map(serializeOutput)
  }
  return base
}

export interface SerializeOptions {
  /** Leave outputs and execution counts out (used when the browser's storage is full). */
  withoutOutputs?: boolean
  /** Secrets that must never be written to a file. Every occurrence is replaced. */
  redact?: string[]
}

export const REDACTED = '[hidden: Hugging Face token]'

/** Replace every occurrence of the given secrets in a piece of text. */
export function redactText(text: string, secrets: readonly string[] | undefined): string {
  if (!secrets) return text
  let out = text
  for (const secret of secrets) {
    if (secret.length >= 8 && out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  return out
}

/** The notebook as the object that goes into the file (nbformat 4.5). */
export function toIpynbObject(notebook: Notebook, options: SerializeOptions = {}): JsonObject {
  const cells = notebook.cells.map((cell) =>
    serializeCell(options.withoutOutputs ? { ...cell, outputs: [], execution_count: null } : cell),
  )
  return {
    ...notebook.extra,
    cells,
    metadata: defaultMetadata(notebook.metadata),
    nbformat: 4,
    // Cell ids exist from nbformat 4.5 on.
    nbformat_minor: Math.max(5, notebook.nbformat_minor),
  }
}

/** The text of the `.ipynb` file: JSON with one space of indentation and a final newline, like Jupyter. */
export function serializeNotebook(notebook: Notebook, options: SerializeOptions = {}): string {
  const text = JSON.stringify(toIpynbObject(notebook, options), null, 1) + '\n'
  // A token is letters, digits and underscores, so it looks the same inside a JSON string.
  return redactText(text, options.redact)
}

// --- Tags ---------------------------------------------------------------------------------------

export const CHECK_TAG = 'check'

export function cellTags(cell: Cell): string[] {
  const tags = cell.metadata.tags
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : []
}

export function hasTag(cell: Cell, tag: string): boolean {
  return cellTags(cell).includes(tag)
}

/** Add or remove a tag. Other tags and other metadata stay as they are. */
export function setTag(cell: Cell, tag: string, on: boolean): void {
  const tags = cellTags(cell).filter((t) => t !== tag)
  if (on) tags.push(tag)
  const metadata = { ...cell.metadata }
  if (tags.length > 0) metadata.tags = tags
  else delete metadata.tags
  cell.metadata = metadata
}

export type CheckState = 'not-run' | 'passed' | 'failed'

/** A check cell passes when it ran without raising. This is derived from the cell, so it survives a reload. */
export function checkState(cell: Cell): CheckState {
  if (cell.execution_count === null) return 'not-run'
  return cell.outputs.some((output) => output.output_type === 'error') ? 'failed' : 'passed'
}
