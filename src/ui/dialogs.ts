/** The two dialogs of the page: the Hugging Face token and the microphone. Both use <dialog>. */
import { getToken, setToken } from '../runtime/token.ts'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  const { class: className, ...rest } = props
  if (className) node.className = className
  Object.assign(node, rest)
  node.append(...children)
  return node
}

export const TOKEN_PATTERN = /^hf_[A-Za-z0-9]{8,}$/

/** Ask for the token. Resolves with whether a token is set afterwards. */
export function openTokenDialog(): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = Boolean(getToken())
    const input = el('input', { type: 'password', id: 'hf-token-input', autocomplete: 'off', spellcheck: false })
    input.setAttribute('aria-describedby', 'hf-token-help hf-token-error')
    input.placeholder = existing ? 'A token is set. Paste a new one to replace it.' : 'hf_…'
    const error = el('p', { id: 'hf-token-error', class: 'dialog-error' })
    error.setAttribute('role', 'alert')
    const link = el('a', { href: 'https://huggingface.co/settings/tokens', target: '_blank', rel: 'noopener noreferrer' }, [
      'huggingface.co/settings/tokens',
    ])
    const save = el('button', { type: 'submit', class: 'button primary' }, ['Save'])
    const cancel = el('button', { type: 'button', class: 'button' }, ['Cancel'])
    const remove = el('button', { type: 'button', class: 'button danger' }, ['Remove token'])
    remove.hidden = !existing
    const form = el('form', { method: 'dialog', noValidate: true }, [
      el('h2', { id: 'hf-token-title' }, ['Your Hugging Face token']),
      el('p', { id: 'hf-token-help' }, [
        'Only the optional cells that call models hosted by Hugging Face need it. The token is kept in this ' +
          'browser only. It is not written into notebook files and is sent only to Hugging Face. Create one at ',
        link,
        ' (a fine-grained token that may “make calls to Inference Providers” is enough).',
      ]),
      el('label', { htmlFor: 'hf-token-input' }, ['Token']),
      input,
      error,
      el('div', { class: 'dialog-buttons' }, [remove, cancel, save]),
    ])
    const dialog = el('dialog', { class: 'dialog' }, [form])
    dialog.setAttribute('aria-labelledby', 'hf-token-title')

    const close = () => {
      dialog.close()
      dialog.remove()
      resolve(Boolean(getToken()))
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const value = input.value.trim()
      if (!TOKEN_PATTERN.test(value)) {
        error.textContent = 'That does not look like a Hugging Face token. A token starts with “hf_” followed by letters and digits.'
        input.focus()
        return
      }
      setToken(value)
      close()
    })
    remove.addEventListener('click', () => {
      setToken(null)
      close()
    })
    cancel.addEventListener('click', close)
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      close()
    })
    document.body.append(dialog)
    dialog.showModal()
    input.focus()
  })
}

export class RecordingError extends Error {
  constructor(
    name: 'LabError' | 'PermissionError',
    message: string,
  ) {
    super(message)
    this.name = name
  }
}

/**
 * Ask before recording, then record `seconds` from the microphone. The click on "Start recording"
 * is the student's consent for this one recording; the browser asks for the microphone itself the
 * first time. Resolves with the recorded file (whatever container the browser's recorder writes).
 */
export function recordWithDialog(seconds: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const text = el('p', { id: 'record-text' }, [
      `This notebook asks to record ${formatSeconds(seconds)} from your microphone. ` +
        'The sound stays in this browser unless a cell of the notebook sends it somewhere.',
    ])
    const state = el('p', { class: 'record-state' })
    state.setAttribute('role', 'status')
    const meter = el('progress', { max: 1, value: 0 })
    meter.hidden = true
    meter.setAttribute('aria-label', 'Recording progress')
    const start = el('button', { type: 'button', class: 'button primary' }, ['Start recording'])
    const cancel = el('button', { type: 'button', class: 'button' }, ['Cancel'])
    const dialog = el('dialog', { class: 'dialog' }, [
      el('h2', { id: 'record-title' }, ['Record from the microphone']),
      text,
      state,
      meter,
      el('div', { class: 'dialog-buttons' }, [cancel, start]),
    ])
    dialog.setAttribute('aria-labelledby', 'record-title')

    let stream: MediaStream | null = null
    let recorder: MediaRecorder | null = null
    let timer = 0
    let settled = false

    const finish = (result: Blob | RecordingError) => {
      if (settled) return
      settled = true
      window.clearInterval(timer)
      stream?.getTracks().forEach((track) => track.stop())
      dialog.close()
      dialog.remove()
      if (result instanceof Blob) resolve(result)
      else reject(result)
    }
    const cancelled = () => {
      if (recorder && recorder.state !== 'inactive') {
        recorder.ondataavailable = null
        recorder.onstop = null
        recorder.stop()
      }
      finish(new RecordingError('LabError', 'The recording was cancelled.'))
    }

    start.addEventListener('click', async () => {
      start.disabled = true
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        finish(new RecordingError('LabError', 'This browser cannot record sound here (it needs a secure https page and a microphone).'))
        return
      }
      state.textContent = 'Waiting for permission to use the microphone…'
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (err) {
        const name = (err as DOMException)?.name
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          finish(
            new RecordingError(
              'PermissionError',
              'The microphone was refused. Allow the microphone for this site (the icon in the address bar) and run the cell again.',
            ),
          )
        } else if (name === 'NotFoundError') {
          finish(new RecordingError('LabError', 'No microphone was found on this device.'))
        } else {
          finish(new RecordingError('LabError', `The microphone could not be opened: ${String((err as Error)?.message ?? err)}`))
        }
        return
      }
      if (settled) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const chunks: Blob[] = []
      recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onstop = () => finish(new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' }))
      recorder.onerror = () => finish(new RecordingError('LabError', 'The recording failed.'))
      recorder.start()
      const began = performance.now()
      meter.hidden = false
      const tick = () => {
        const elapsed = (performance.now() - began) / 1000
        meter.value = Math.min(1, elapsed / seconds)
        state.textContent = `Recording… ${Math.max(0, seconds - elapsed).toFixed(1)} s left`
        if (elapsed >= seconds && recorder && recorder.state !== 'inactive') {
          window.clearInterval(timer)
          recorder.stop()
        }
      }
      tick()
      timer = window.setInterval(tick, 100)
    })
    cancel.addEventListener('click', cancelled)
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      cancelled()
    })
    document.body.append(dialog)
    dialog.showModal()
    start.focus()
  })
}

function formatSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10
  return `${rounded} second${rounded === 1 ? '' : 's'}`
}
