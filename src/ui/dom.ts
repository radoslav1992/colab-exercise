/** Small helpers for building the page by hand (there is no UI framework). */

type Child = Node | string | null | undefined | false

/** Create an element. `class` sets the class name; other properties are assigned as they are. Text is always set as text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & { class?: string } = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  const { class: className, ...rest } = props
  if (className) node.className = className
  Object.assign(node, rest)
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child)
  return node
}

export function button(label: string, onClick: () => void, className = 'button'): HTMLButtonElement {
  const node = el('button', { type: 'button', class: className }, [label])
  node.addEventListener('click', onClick)
  return node
}

let nextId = 1

/** An id that is unique on the page, for label/field pairs. */
export function uid(prefix: string): string {
  return `${prefix}-${nextId++}`
}

export interface Field<T extends HTMLElement> {
  row: HTMLElement
  input: T
}

/** A labelled field: <div class="field"><label>…</label>input<p class="field-help">…</p></div>. */
export function field<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(label: string, input: T, help = ''): Field<T> {
  if (!input.id) input.id = uid('field')
  const row = el('div', { class: 'field' }, [el('label', { htmlFor: input.id }, [label]), input])
  if (help) {
    const text = el('p', { class: 'field-help', id: `${input.id}-help` }, [help])
    input.setAttribute('aria-describedby', text.id)
    row.append(text)
  }
  return { row, input }
}

/** A message area that screen readers announce. */
export function messageBox(kind: 'error' | 'status' = 'error'): HTMLParagraphElement {
  const node = el('p', { class: kind === 'error' ? 'form-error' : 'form-status' })
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  return node
}

/** Offer `data` as a download with the given file name. Built in the browser; nothing is asked of the server. */
export function downloadBlob(data: Blob, fileName: string): void {
  const url = URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

/** A stored time (UTC milliseconds) in the reader's own time zone. */
export function formatDateTime(ms: number): string {
  return DATE_TIME.format(new Date(ms))
}

export function formatDate(ms: number): string {
  return DATE.format(new Date(ms))
}

/** The value of an <input type="datetime-local"> for a stored time, in local time. */
export function toLocalInput(ms: number | null): string {
  if (ms === null) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The time an <input type="datetime-local"> holds (local time) as UTC milliseconds; null when empty or not a date. */
export function fromLocalInput(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} bytes`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} kB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** "3", "8.5", "9.25": a grade or a number of points without trailing zeros. */
export function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100)
}
