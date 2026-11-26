/** Turning notebook outputs into DOM. Everything that is HTML goes through the sanitizer. */
import type { DisplayOutput, ErrorOutput, Output, StreamOutput } from '../notebook/ipynb.ts'
import { renderMarkdown } from '../notebook/markdown.ts'
import { cleanBase64, sanitizeHtml } from '../notebook/sanitize.ts'

/** Colour codes that Jupyter puts into tracebacks and some libraries print. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

/** How much text of one stream is shown. The rest stays in the notebook file. */
const MAX_SHOWN = 200_000

/** What a terminal would show: colour codes removed, and "\r" returning to the start of the line. */
export function terminalText(text: string): string {
  const clean = text.replace(ANSI, '')
  if (!clean.includes('\r')) return clean
  return clean
    .split('\n')
    .map((line) => {
      const trimmed = line.replace(/\r+$/, '')
      return trimmed.slice(trimmed.lastIndexOf('\r') + 1)
    })
    .join('\n')
}

function pre(className: string, text: string): HTMLPreElement {
  const node = document.createElement('pre')
  node.className = className
  node.textContent = text
  return node
}

export function streamText(output: StreamOutput): string {
  const text = terminalText(output.text)
  if (text.length <= MAX_SHOWN) return text
  return text.slice(0, MAX_SHOWN) + `\n… ${text.length - MAX_SHOWN} more characters are not shown`
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

function renderDisplay(output: DisplayOutput): HTMLElement {
  const data = output.data
  const plain = typeof data['text/plain'] === 'string' ? (data['text/plain'] as string) : ''
  const box = document.createElement('div')
  box.className = 'output-rich'

  if (typeof data['text/html'] === 'string') {
    box.classList.add('output-html')
    box.innerHTML = sanitizeHtml(data['text/html'])
    return box
  }
  if (typeof data['image/svg+xml'] === 'string') {
    // As an image, an SVG can neither run scripts nor load anything.
    const img = document.createElement('img')
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data['image/svg+xml'])}`
    img.alt = plain || 'Image output'
    box.append(img)
    return box
  }
  for (const mime of IMAGE_TYPES) {
    const value = data[mime]
    const base64 = typeof value === 'string' ? cleanBase64(value) : null
    if (base64) {
      const img = document.createElement('img')
      img.src = `data:${mime};base64,${base64}`
      img.alt = plain || 'Image output'
      box.append(img)
      return box
    }
  }
  for (const mime of ['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm']) {
    const value = data[mime]
    const base64 = typeof value === 'string' ? cleanBase64(value) : null
    if (base64) {
      const audio = document.createElement('audio')
      audio.controls = true
      audio.src = `data:${mime};base64,${base64}`
      box.append(audio)
      return box
    }
  }
  if (typeof data['text/markdown'] === 'string') {
    box.classList.add('markdown')
    box.innerHTML = renderMarkdown(data['text/markdown'])
    return box
  }
  if ('application/json' in data) {
    return pre('output-text', JSON.stringify(data['application/json'], null, 2))
  }
  return pre('output-text', terminalText(plain))
}

/** One output as an element. Stream outputs get a <pre> whose text the caller may update later. */
export function renderOutput(output: Output): HTMLElement {
  switch (output.output_type) {
    case 'stream': {
      const stream = output as StreamOutput
      return pre(`output-text stream-${stream.name}`, streamText(stream))
    }
    case 'error': {
      const error = output as ErrorOutput
      const text = error.traceback.length > 0 ? error.traceback.join('\n') : `${error.ename}: ${error.evalue}`
      const node = pre('output-text output-error', terminalText(text))
      node.setAttribute('role', 'alert')
      return node
    }
    case 'display_data':
    case 'execute_result':
      return renderDisplay(output as DisplayOutput)
    default:
      return pre('output-text', JSON.stringify(output, null, 2))
  }
}
