/** The notebook page: toolbar, status line, the list of cells, running, saving, opening and downloading. */
import {
  CHECK_TAG,
  checkState,
  emptyNotebook,
  hasTag,
  newCell,
  NotebookFormatError,
  parseNotebook,
  redactText,
  serializeNotebook,
  setTag,
  type Cell,
  type DisplayOutput,
  type Notebook,
} from './notebook/ipynb.ts'
import { Runtime, type RuntimeState } from './runtime/client.ts'
import type { Status } from './runtime/protocol.ts'
import { hasToken, onTokenChange, secrets } from './runtime/token.ts'
import { loadSample, samples } from './samples.ts'
import {
  currentDocId,
  deleteDoc,
  loadDoc,
  saveDoc,
  savedTheme,
  saveTheme,
  setCurrentDocId,
  type Theme,
} from './storage.ts'
import { CellView, type CellHost } from './ui/cell.ts'
import { openTokenDialog } from './ui/dialogs.ts'

type SaveState = 'saved' | 'pending' | 'partial' | 'failed'

const FILE_DOC = 'file'
/** Text of one cell's streams beyond this is dropped while it runs, so a runaway loop cannot fill the memory. */
const MAX_STREAM_CHARS = 2_000_000

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

export class App implements CellHost {
  private notebook: Notebook = emptyNotebook()
  private docId = FILE_DOC
  private docName = 'notebook.ipynb'
  private views: CellView[] = []
  private queue: CellView[] = []
  private running: CellView | null = null
  private executionCounter = 0
  private saveTimer = 0
  private saveState: SaveState = 'saved'
  private streamChars = 0
  private deleted: { cell: Cell; index: number } | null = null
  private noticeTimer = 0

  private readonly runtime: Runtime
  private readonly cellsEl = h('main', 'cells')
  private readonly select = h('select', 'notebook-select')
  private readonly statusEl = h('span', 'runtime-status')
  private readonly statusText = h('span')
  private readonly progress = h('progress', 'runtime-progress')
  private readonly saveEl = h('span', 'save-state')
  private readonly checksEl = h('span', 'checks-summary')
  private readonly noticeEl = h('div', 'notice')
  private readonly tokenButton = h('button', 'button')
  private readonly resetButton = h('button', 'button')
  private readonly themeButton = h('button', 'button')
  private readonly fileInput = h('input')
  private readonly dropHint = h('div', 'drop-hint', 'Drop the .ipynb file to open it')

  constructor(private readonly root: HTMLElement) {
    this.runtime = new Runtime({ status: (status, state, detail) => this.showStatus(status, state, detail) })
    this.build()
    this.applyTheme(savedTheme())
    onTokenChange(() => this.showToken())
    window.addEventListener('beforeunload', () => this.saveNow())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.saveNow()
    })
  }

  // --- Building the page ------------------------------------------------------------------------

  private build(): void {
    const header = h('header', 'topbar')
    const brand = h('div', 'brand')
    brand.append(h('span', 'brand-name', 'Notebook Lab'), h('span', 'brand-tag', 'prototype'))

    const picker = h('div', 'picker')
    const label = h('label', 'visually-hidden', 'Notebook')
    label.htmlFor = 'notebook-select'
    this.select.id = 'notebook-select'
    this.select.addEventListener('change', () => void this.openDoc(this.select.value))
    picker.append(label, this.select)

    const actions = h('div', 'actions')
    actions.setAttribute('role', 'toolbar')
    actions.setAttribute('aria-label', 'Notebook actions')
    const action = (text: string, onClick: () => void, className = 'button', title = ''): HTMLButtonElement => {
      const node = h('button', className, text)
      node.type = 'button'
      if (title) node.title = title
      node.addEventListener('click', onClick)
      actions.append(node)
      return node
    }
    action('Run all', () => this.runAll(), 'button primary', 'Run every code cell from top to bottom')
    action('Clear outputs', () => this.clearOutputs())
    action('Restart', () => this.restart(), 'button', 'Stop Python and forget all variables')
    action('Open', () => this.fileInput.click(), 'button', 'Open a .ipynb file from this device')
    action('Download', () => this.download(), 'button', 'Save this notebook as a .ipynb file')
    this.resetButton.type = 'button'
    this.resetButton.textContent = 'Reset'
    this.resetButton.title = 'Throw away your changes and load the original sample notebook'
    this.resetButton.addEventListener('click', () => void this.resetSample())
    this.tokenButton.type = 'button'
    this.tokenButton.addEventListener('click', () => void openTokenDialog())
    this.themeButton.type = 'button'
    this.themeButton.addEventListener('click', () => this.toggleTheme())
    actions.append(this.resetButton, this.tokenButton, this.themeButton)

    this.fileInput.type = 'file'
    this.fileInput.accept = '.ipynb,application/x-ipynb+json,application/json'
    this.fileInput.hidden = true
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0]
      this.fileInput.value = ''
      if (file) void this.openFile(file)
    })
    header.append(brand, picker, actions, this.fileInput)

    const statusbar = h('div', 'statusbar')
    this.statusEl.setAttribute('role', 'status')
    this.statusEl.append(h('span', 'status-dot'), this.statusText)
    this.progress.max = 1
    this.progress.hidden = true
    this.progress.setAttribute('aria-label', 'Download progress')
    this.saveEl.setAttribute('role', 'status')
    statusbar.append(this.statusEl, this.progress, this.checksEl, this.saveEl)

    this.noticeEl.hidden = true
    this.noticeEl.setAttribute('role', 'alert')
    this.cellsEl.id = 'notebook'
    this.cellsEl.setAttribute('aria-label', 'Notebook cells')
    this.dropHint.hidden = true

    const footer = h('footer', 'footer')
    footer.append(
      'Python runs in this browser tab (Pyodide); models run on this computer. Notebooks are saved in this browser only. ',
      'Shift+Enter runs a cell; Escape leaves the editor.',
    )

    const sticky = h('div', 'sticky')
    sticky.append(header, statusbar)
    this.root.append(sticky, this.noticeEl, this.cellsEl, footer, this.dropHint)

    this.showStatus(null, 'stopped')
    this.showSave('saved')
    this.showToken()
    this.installDragAndDrop()
  }

  private installDragAndDrop(): void {
    let depth = 0
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return
      depth += 1
      this.dropHint.hidden = false
    })
    window.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) this.dropHint.hidden = true
    })
    window.addEventListener('dragover', (event) => {
      if (hasFiles(event)) event.preventDefault()
    })
    window.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      this.dropHint.hidden = true
      const file = event.dataTransfer?.files[0]
      if (file) void this.openFile(file)
    })
  }

  // --- Status line ------------------------------------------------------------------------------

  private showStatus(status: Status | null, state: RuntimeState, detail = ''): void {
    let kind: string
    let text: string
    if (state === 'failed') {
      kind = 'failed'
      text = `Python could not start: ${detail}. Check your connection and press Restart.`
    } else if (state === 'stopped' || !status) {
      kind = state === 'stopped' ? 'stopped' : 'loading'
      text = state === 'stopped' ? 'Python starts when you run a cell' : 'Starting Python…'
    } else if (status.kind === 'idle') {
      kind = 'idle'
      const info = this.runtime.info
      text = info ? `Idle · Python ${info.python} · ${info.webgpu ? 'graphics card available (WebGPU)' : 'no WebGPU, models use the CPU'}` : 'Idle'
    } else {
      kind = status.kind === 'running' ? 'running' : 'loading'
      text = `${status.text}…`
    }
    this.statusEl.dataset.runtime = kind
    this.statusText.textContent = text
    const progress = status?.progress
    this.progress.hidden = progress === undefined || state === 'failed'
    if (progress !== undefined) this.progress.value = progress
  }

  private showSave(state: SaveState): void {
    this.saveState = state
    this.saveEl.dataset.save = state
    this.saveEl.textContent = {
      saved: 'Saved in this browser',
      pending: 'Saving…',
      partial: 'Saved without outputs (browser storage is full)',
      failed: 'Not saved: browser storage is unavailable. Download the notebook to keep it.',
    }[state]
  }

  private showToken(): void {
    const set = hasToken()
    this.tokenButton.textContent = set ? 'HF token: set' : 'HF token'
    this.tokenButton.title = set
      ? 'A Hugging Face token is stored in this browser. Press to replace or remove it.'
      : 'Set your Hugging Face token (only needed for hosted models)'
  }

  private showChecks(): void {
    const checks = this.notebook.cells.filter((cell) => cell.cell_type === 'code' && hasTag(cell, CHECK_TAG))
    const passed = checks.filter((cell) => checkState(cell) === 'passed').length
    const failed = checks.filter((cell) => checkState(cell) === 'failed').length
    this.checksEl.hidden = checks.length === 0
    this.checksEl.dataset.failed = String(failed)
    this.checksEl.textContent = `Checks: ${passed} of ${checks.length} passed`
  }

  private notify(text: string, action?: { label: string; run(): void }): void {
    window.clearTimeout(this.noticeTimer)
    this.noticeEl.replaceChildren(h('span', '', text))
    if (action) {
      const button = h('button', 'button', action.label)
      button.type = 'button'
      button.addEventListener('click', () => {
        this.noticeEl.hidden = true
        action.run()
      })
      this.noticeEl.append(button)
    }
    const close = h('button', 'button', 'Dismiss')
    close.type = 'button'
    close.addEventListener('click', () => (this.noticeEl.hidden = true))
    this.noticeEl.append(close)
    this.noticeEl.hidden = false
    if (action) this.noticeTimer = window.setTimeout(() => (this.noticeEl.hidden = true), 10_000)
  }

  // --- Theme ------------------------------------------------------------------------------------

  private effectiveTheme(): Theme {
    const set = document.documentElement.dataset.theme
    if (set === 'light' || set === 'dark') return set
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  private applyTheme(theme: Theme | null): void {
    if (theme) document.documentElement.dataset.theme = theme
    const now = this.effectiveTheme()
    this.themeButton.textContent = now === 'dark' ? 'Light' : 'Dark'
    this.themeButton.setAttribute('aria-label', now === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme')
  }

  private toggleTheme(): void {
    const next: Theme = this.effectiveTheme() === 'dark' ? 'light' : 'dark'
    saveTheme(next)
    this.applyTheme(next)
  }

  // --- Documents: samples, opened files, autosave -----------------------------------------------

  /** First load: the notebook that was open last time, else the first sample. */
  async start(): Promise<void> {
    const last = currentDocId()
    const known = last && (last === FILE_DOC ? loadDoc(FILE_DOC) !== null : samples.some((s) => `sample:${s.file}` === last))
    await this.openDoc(known ? last : `sample:${samples[0].file}`)
  }

  private fillSelect(): void {
    this.select.replaceChildren()
    const group = document.createElement('optgroup')
    group.label = 'Course notebooks'
    for (const sample of samples) {
      const option = new Option(sample.title, `sample:${sample.file}`)
      group.append(option)
    }
    this.select.append(group)
    const file = loadDoc(FILE_DOC)
    if (file || this.docId === FILE_DOC) {
      const other = document.createElement('optgroup')
      other.label = 'Opened from this device'
      other.append(new Option(this.docId === FILE_DOC ? this.docName : file!.name, FILE_DOC))
      this.select.append(other)
    }
    this.select.value = this.docId
  }

  private async openDoc(id: string): Promise<void> {
    this.saveNow()
    let name: string
    let text: string
    const saved = loadDoc(id)
    if (saved) {
      name = saved.name
      text = saved.text
    } else if (id.startsWith('sample:')) {
      name = id.slice('sample:'.length)
      try {
        text = await loadSample(name)
      } catch (err) {
        this.notify(`Could not load the notebook: ${(err as Error).message}`)
        this.select.value = this.docId
        return
      }
    } else {
      this.select.value = this.docId
      return
    }
    let notebook: Notebook
    try {
      notebook = parseNotebook(text)
    } catch {
      // A damaged autosave must not lock the student out of the sample.
      deleteDoc(id)
      if (id.startsWith('sample:')) return this.openDoc(id)
      this.notify('The saved copy of this notebook could not be read.')
      return
    }
    this.setNotebook(notebook, id, name)
    setCurrentDocId(id)
  }

  private async openFile(file: File): Promise<void> {
    let notebook: Notebook
    try {
      notebook = parseNotebook(await file.text())
    } catch (err) {
      this.notify(err instanceof NotebookFormatError ? err.message : `Could not read ${file.name}.`)
      return
    }
    this.saveNow()
    const name = file.name.toLowerCase().endsWith('.ipynb') ? file.name : `${file.name}.ipynb`
    this.setNotebook(notebook, FILE_DOC, name)
    this.saveNow(true)
  }

  private async resetSample(): Promise<void> {
    if (!this.docId.startsWith('sample:')) return
    if (!window.confirm('Throw away your changes to this notebook and load the original?')) return
    window.clearTimeout(this.saveTimer)
    this.saveTimer = 0
    deleteDoc(this.docId)
    this.showSave('saved')
    await this.openDoc(this.docId)
  }

  /** Replace the notebook on the page. Python is stopped: another notebook starts with a clean memory. */
  private setNotebook(notebook: Notebook, id: string, name: string): void {
    this.stopRuntime()
    for (const view of this.views) view.destroy()
    this.notebook = notebook
    this.docId = id
    this.docName = name
    this.deleted = null
    this.noticeEl.hidden = true
    this.views = notebook.cells.map((cell) => new CellView(cell, this))
    this.cellsEl.replaceChildren(...this.views.map((view) => view.root))
    if (this.views.length === 0) this.insertAt(0, 'code')
    this.renumber()
    this.fillSelect()
    this.resetButton.hidden = !id.startsWith('sample:')
    document.title = `${name} · Notebook Lab`
    this.showChecks()
    window.scrollTo({ top: 0 })
  }

  changed(): void {
    this.showSave('pending')
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.saveNow(), 600)
  }

  /** Write the notebook to localStorage now, if there is something to write. */
  private saveNow(force = false): void {
    if (!force && this.saveState !== 'pending') return
    window.clearTimeout(this.saveTimer)
    this.saveTimer = 0
    const redact = secrets()
    const doc = { id: this.docId, name: this.docName }
    if (saveDoc({ ...doc, text: serializeNotebook(this.notebook, { redact }) })) {
      this.showSave('saved')
    } else if (saveDoc({ ...doc, text: serializeNotebook(this.notebook, { redact, withoutOutputs: true }) })) {
      this.showSave('partial')
    } else {
      this.showSave('failed')
    }
  }

  private download(): void {
    const text = serializeNotebook(this.notebook, { redact: secrets() })
    const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ipynb+json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = this.docName
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  // --- Cells ------------------------------------------------------------------------------------

  private renumber(): void {
    this.views.forEach((view, index) => view.setPosition(index, this.views.length))
  }

  private insertAt(index: number, type: 'code' | 'markdown', cell?: Cell): CellView {
    const taken = new Set(this.notebook.cells.map((c) => c.id))
    const created = cell ?? newCell(type, '', taken)
    const view = new CellView(created, this)
    this.notebook.cells.splice(index, 0, created)
    this.views.splice(index, 0, view)
    this.cellsEl.insertBefore(view.root, this.views[index + 1]?.root ?? null)
    this.renumber()
    return view
  }

  insertAfter(view: CellView, type: 'code' | 'markdown'): void {
    const created = this.insertAt(this.views.indexOf(view) + 1, type)
    created.focusEditor()
    this.changed()
  }

  remove(view: CellView): void {
    const index = this.views.indexOf(view)
    if (index < 0) return
    this.queue = this.queue.filter((queued) => queued !== view)
    this.notebook.cells.splice(index, 1)
    this.views.splice(index, 1)
    view.destroy()
    this.deleted = { cell: view.cell, index }
    if (this.views.length === 0) this.insertAt(0, 'code')
    this.renumber()
    ;(this.views[index] ?? this.views[index - 1])?.focusPrimary()
    this.showChecks()
    this.changed()
    this.notify('Cell deleted.', { label: 'Undo', run: () => this.undoDelete() })
  }

  private undoDelete(): void {
    if (!this.deleted) return
    const { cell, index } = this.deleted
    this.deleted = null
    const view = this.insertAt(Math.min(index, this.views.length), cell.cell_type === 'code' ? 'code' : 'markdown', cell)
    view.focusPrimary()
    this.showChecks()
    this.changed()
  }

  move(view: CellView, delta: -1 | 1): void {
    const from = this.views.indexOf(view)
    const to = from + delta
    if (from < 0 || to < 0 || to >= this.views.length) return
    this.views.splice(to, 0, ...this.views.splice(from, 1))
    this.notebook.cells.splice(to, 0, ...this.notebook.cells.splice(from, 1))
    this.cellsEl.insertBefore(view.root, this.views[to + 1]?.root ?? null)
    this.renumber()
    view.root.scrollIntoView({ block: 'nearest' })
    this.changed()
  }

  convert(view: CellView): void {
    const index = this.views.indexOf(view)
    if (index < 0 || view.state !== 'idle') return
    const cell = view.cell
    cell.cell_type = cell.cell_type === 'code' ? 'markdown' : 'code'
    cell.outputs = []
    cell.execution_count = null
    view.destroy()
    const replacement = new CellView(cell, this)
    this.views[index] = replacement
    this.cellsEl.insertBefore(replacement.root, this.views[index + 1]?.root ?? null)
    this.renumber()
    if (cell.cell_type === 'markdown') replacement.edit()
    else replacement.focusEditor()
    this.showChecks()
    this.changed()
  }

  toggleCheck(view: CellView): void {
    setTag(view.cell, CHECK_TAG, !hasTag(view.cell, CHECK_TAG))
    view.refresh()
    this.showChecks()
    this.changed()
  }

  private clearOutputs(): void {
    for (const view of this.views) {
      if (view.cell.cell_type !== 'code' || view.state !== 'idle') continue
      view.clearOutputs()
      view.cell.execution_count = null
      view.refresh()
    }
    this.showChecks()
    this.changed()
  }

  // --- Running ----------------------------------------------------------------------------------

  run(view: CellView, advance: boolean): void {
    if (view.cell.cell_type !== 'code') {
      view.render()
    } else if (view.state === 'idle') {
      view.state = 'queued'
      view.refresh()
      this.queue.push(view)
      void this.drain()
    }
    if (advance) {
      const next = this.views[this.views.indexOf(view) + 1]
      if (next) next.focusEditor()
      else view.focusPrimary()
    }
  }

  private runAll(): void {
    for (const view of this.views) {
      if (view.cell.cell_type === 'code' && view.state === 'idle' && view.cell.source.trim() !== '') {
        view.state = 'queued'
        view.refresh()
        this.queue.push(view)
      }
    }
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    for (;;) {
      const view = this.queue.shift()
      if (!view) break
      this.running = view
      view.clearOutputs()
      view.cell.execution_count = null
      view.state = 'running'
      view.refresh()
      this.streamChars = 0
      const label = ++this.executionCounter
      const error = await this.runtime.run(view.cell.source, label, {
        stream: (name, text) => this.onStream(view, name, text),
        display: (output) => this.onDisplay(view, output, label),
      })
      view.flushStream()
      if (error) {
        const hide = (text: string) => redactText(text, secrets())
        view.appendOutput({
          output_type: 'error',
          ename: error.ename,
          evalue: hide(error.evalue),
          traceback: error.traceback.map(hide),
        })
      }
      view.cell.execution_count = label
      view.state = 'idle'
      view.refresh()
      this.running = null
      this.showChecks()
      this.changed()
      // Like Jupyter, "Run all" stops at the first error. A failed check is a result, not a stop.
      if (error && (!hasTag(view.cell, CHECK_TAG) || error.ename === 'RuntimeRestarted')) {
        for (const waiting of this.queue.splice(0)) {
          waiting.state = 'idle'
          waiting.refresh()
        }
      }
    }
  }

  private onStream(view: CellView, name: 'stdout' | 'stderr', text: string): void {
    if (this.streamChars > MAX_STREAM_CHARS) return
    this.streamChars += text.length
    const shown =
      this.streamChars > MAX_STREAM_CHARS ? '\n[Output cut off here: this cell printed more than 2 million characters.]\n' : text
    view.appendStream(name, redactText(shown, secrets()))
  }

  private onDisplay(view: CellView, output: DisplayOutput, label: number): void {
    const hidden = secrets()
    const data: Record<string, unknown> = {}
    for (const [mime, value] of Object.entries(output.data ?? {})) {
      data[mime] = typeof value === 'string' ? redactText(value, hidden) : value
    }
    view.flushStream()
    const clean: DisplayOutput = { output_type: output.output_type, data, metadata: output.metadata ?? {} }
    if (output.output_type === 'execute_result') clean.execution_count = label
    view.appendOutput(clean)
  }

  private stopRuntime(): void {
    for (const waiting of this.queue.splice(0)) {
      waiting.state = 'idle'
      waiting.refresh()
    }
    this.runtime.stop()
    this.executionCounter = 0
  }

  /** Terminate the worker and start a fresh one: all variables and loaded models are gone. */
  private restart(): void {
    this.stopRuntime()
    void this.runtime.start().catch(() => {
      // The status line shows why Python could not start.
    })
  }
}
