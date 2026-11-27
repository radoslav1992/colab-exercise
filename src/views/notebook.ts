/**
 * The notebook view: toolbar, status line, the list of cells, running, opening and downloading.
 *
 * It is used in three ways:
 *   playground  the sample notebooks and files from this device, saved in this browser only
 *               (exactly what the site is for somebody who is not signed in);
 *   remote      a notebook that lives on the server (a student's copy of an assignment, a
 *               teacher's starter); whoever creates the view saves it (src/sync.ts);
 *   review      a submission as a teacher sees it; nothing is saved anywhere.
 */
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
} from '../notebook/ipynb.ts'
import { Runtime, type RuntimeState } from '../runtime/client.ts'
import type { Status } from '../runtime/protocol.ts'
import { hasToken, onTokenChange, secrets } from '../runtime/token.ts'
import { loadSample, samples } from '../samples.ts'
import { currentDocId, deleteDoc, loadDoc, saveDoc, setCurrentDocId } from '../storage.ts'
import { CellView, type CellHost } from '../ui/cell.ts'
import { openTokenDialog } from '../ui/dialogs.ts'
import { downloadBlob } from '../ui/dom.ts'

/** A view of the page (src/app.ts shows one at a time). */
export interface View {
  readonly root: HTMLElement
  /** Called when the view is replaced: stop timers, workers and listeners. */
  destroy(): void
}

export type SaveKind = 'saved' | 'pending' | 'partial' | 'failed' | 'offline' | 'conflict' | 'unsaved'

export interface NotebookOptions {
  mode: 'playground' | 'remote' | 'review'
  /** Shown where the playground has its menu of notebooks. */
  heading?: string
  /** "Open" and drag and drop replace the notebook with a file from this device. */
  canOpenFiles?: boolean
  /** Shown above the cells (the assignment, the grade form). */
  panel?: HTMLElement
  /** More buttons for the toolbar. */
  actions?: HTMLElement[]
  /** Replaces the last sentence of the footer, which says where the notebook is saved. */
  savedWhere?: string
  /** remote: the notebook changed and should be saved. */
  onChanged?(): void
  /** remote: a file from this device replaced the notebook. */
  onFileOpened?(name: string): void
  /** What "Download" saves, when it is not the notebook as it is on the page. */
  downloadText?(): string | null
}

const FILE_DOC = 'file'
/** Text of one cell's streams beyond this is dropped while it runs, so a runaway loop cannot fill the memory. */
const MAX_STREAM_CHARS = 2_000_000

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

export class NotebookView implements CellHost, View {
  readonly root = h('div', 'notebook-view')
  private notebook: Notebook = emptyNotebook()
  private docId = FILE_DOC
  private docName = 'notebook.ipynb'
  private views: CellView[] = []
  private queue: CellView[] = []
  private running: CellView | null = null
  private executionCounter = 0
  private saveTimer = 0
  private saveState: SaveKind = 'saved'
  private streamChars = 0
  private deleted: { cell: Cell; index: number } | null = null
  private noticeTimer = 0
  private destroyed = false

  private readonly runtime: Runtime
  private readonly listeners = new AbortController()
  private readonly stopTokenUpdates: () => void
  private readonly cellsEl = h('main', 'cells')
  private readonly select = h('select', 'notebook-select')
  private readonly headingEl = h('div', 'notebook-heading')
  private readonly statusEl = h('span', 'runtime-status')
  private readonly statusText = h('span')
  private readonly progress = h('progress', 'runtime-progress')
  private readonly saveEl = h('span', 'save-state')
  private readonly checksEl = h('span', 'checks-summary')
  private readonly noticeEl = h('div', 'notice')
  private readonly tokenButton = h('button', 'button')
  private readonly resetButton = h('button', 'button')
  private readonly fileInput = h('input')
  private readonly dropHint = h('div', 'drop-hint', 'Drop the .ipynb file to open it')

  constructor(private readonly options: NotebookOptions = { mode: 'playground' }) {
    this.runtime = new Runtime({ status: (status, state, detail) => this.showStatus(status, state, detail) })
    this.build()
    this.stopTokenUpdates = onTokenChange(() => this.showToken())
    if (options.mode === 'playground') {
      const signal = this.listeners.signal
      window.addEventListener('beforeunload', () => this.saveNow(), { signal })
      document.addEventListener(
        'visibilitychange',
        () => {
          if (document.visibilityState === 'hidden') this.saveNow()
        },
        { signal },
      )
    }
  }

  private get isPlayground(): boolean {
    return this.options.mode === 'playground'
  }

  private get canOpenFiles(): boolean {
    return this.isPlayground || this.options.canOpenFiles === true
  }

  // --- Building the page ------------------------------------------------------------------------

  private build(): void {
    const header = h('div', 'topbar')

    const picker = h('div', 'picker')
    if (this.isPlayground) {
      const label = h('label', 'visually-hidden', 'Notebook')
      label.htmlFor = 'notebook-select'
      this.select.id = 'notebook-select'
      this.select.addEventListener('change', () => void this.openDoc(this.select.value))
      picker.append(label, this.select)
    } else {
      this.headingEl.textContent = this.options.heading ?? ''
      picker.append(this.headingEl)
    }

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
    if (this.canOpenFiles) {
      action('Open', () => this.fileInput.click(), 'button', this.isPlayground ? 'Open a .ipynb file from this device' : 'Replace this notebook with a .ipynb file from this device')
    }
    action('Download', () => this.download(), 'button', 'Save this notebook as a .ipynb file')
    if (this.isPlayground) {
      this.resetButton.type = 'button'
      this.resetButton.textContent = 'Reset'
      this.resetButton.title = 'Throw away your changes and load the original sample notebook'
      this.resetButton.addEventListener('click', () => void this.resetSample())
      actions.append(this.resetButton)
    }
    this.tokenButton.type = 'button'
    this.tokenButton.addEventListener('click', () => void openTokenDialog())
    actions.append(this.tokenButton, ...(this.options.actions ?? []))

    this.fileInput.type = 'file'
    this.fileInput.accept = '.ipynb,application/x-ipynb+json,application/json'
    this.fileInput.hidden = true
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0]
      this.fileInput.value = ''
      if (file) void this.openFile(file)
    })
    header.append(picker, actions, this.fileInput)

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
      'Python runs in this browser tab (Pyodide); models run on this computer. ',
      `${this.options.savedWhere ?? 'Notebooks are saved in this browser only.'} `,
      'Shift+Enter runs a cell; Escape leaves the editor.',
    )

    const sticky = h('div', 'sticky')
    sticky.append(header, statusbar)
    this.root.append(sticky, this.noticeEl)
    if (this.options.panel) this.root.append(this.options.panel)
    this.root.append(this.cellsEl, footer, this.dropHint)

    this.showStatus(null, 'stopped')
    this.showSave('saved')
    this.showToken()
    if (this.canOpenFiles) this.installDragAndDrop()
  }

  private installDragAndDrop(): void {
    const signal = this.listeners.signal
    let depth = 0
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    window.addEventListener(
      'dragenter',
      (event) => {
        if (!hasFiles(event)) return
        depth += 1
        this.dropHint.hidden = false
      },
      { signal },
    )
    window.addEventListener(
      'dragleave',
      (event) => {
        if (!hasFiles(event)) return
        depth = Math.max(0, depth - 1)
        if (depth === 0) this.dropHint.hidden = true
      },
      { signal },
    )
    window.addEventListener(
      'dragover',
      (event) => {
        if (hasFiles(event)) event.preventDefault()
      },
      { signal },
    )
    window.addEventListener(
      'drop',
      (event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        depth = 0
        this.dropHint.hidden = true
        const file = event.dataTransfer?.files[0]
        if (file) void this.openFile(file)
      },
      { signal },
    )
  }

  /** Leave the page: Python stops, and (in the playground) the notebook is saved in this browser. */
  destroy(): void {
    if (this.destroyed) return
    if (this.isPlayground) this.saveNow()
    this.destroyed = true
    window.clearTimeout(this.saveTimer)
    window.clearTimeout(this.noticeTimer)
    this.listeners.abort()
    this.stopTokenUpdates()
    this.queue = []
    this.runtime.dispose()
    for (const view of this.views) view.destroy()
    this.views = []
    this.root.remove()
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

  /** Show where the notebook is saved. The playground has fixed texts; the other modes pass their own. */
  showSave(state: SaveKind, text?: string, title = ''): void {
    this.saveState = state
    this.saveEl.dataset.save = state
    this.saveEl.title = title
    this.saveEl.textContent =
      text ??
      {
        saved: 'Saved in this browser',
        pending: 'Saving…',
        partial: 'Saved without outputs (browser storage is full)',
        failed: 'Not saved: browser storage is unavailable. Download the notebook to keep it.',
        offline: 'Saved in this browser',
        conflict: 'Not saved',
        unsaved: 'Not saved',
      }[state]
  }

  private showToken(): void {
    const set = hasToken()
    this.tokenButton.textContent = set ? 'HF token: set' : 'HF token'
    this.tokenButton.title = set
      ? 'A Hugging Face token is stored in this browser. Press to replace or remove it.'
      : 'Set your Hugging Face token (only needed for hosted models)'
  }

  /** How many check cells there are, and how many of them passed when they last ran. */
  checks(): { passed: number; failed: number; total: number } {
    const cells = this.notebook.cells.filter((cell) => cell.cell_type === 'code' && hasTag(cell, CHECK_TAG))
    return {
      passed: cells.filter((cell) => checkState(cell) === 'passed').length,
      failed: cells.filter((cell) => checkState(cell) === 'failed').length,
      total: cells.length,
    }
  }

  private showChecks(): void {
    const { passed, failed, total } = this.checks()
    this.checksEl.hidden = total === 0
    this.checksEl.dataset.failed = String(failed)
    this.checksEl.textContent = `Checks: ${passed} of ${total} passed`
  }

  /** Show a message above the cells, with buttons. Without `keep`, a message with actions goes away after ten seconds. */
  notify(text: string, actions: Array<{ label: string; run(): void }> = [], keep = false): void {
    window.clearTimeout(this.noticeTimer)
    this.noticeEl.replaceChildren(h('span', '', text))
    for (const action of actions) {
      const button = h('button', 'button', action.label)
      button.type = 'button'
      button.addEventListener('click', () => {
        this.noticeEl.hidden = true
        action.run()
      })
      this.noticeEl.append(button)
    }
    if (!keep) {
      const close = h('button', 'button', 'Dismiss')
      close.type = 'button'
      close.addEventListener('click', () => (this.noticeEl.hidden = true))
      this.noticeEl.append(close)
    }
    this.noticeEl.hidden = false
    if (actions.length > 0 && !keep) this.noticeTimer = window.setTimeout(() => (this.noticeEl.hidden = true), 10_000)
  }

  hideNotice(): void {
    window.clearTimeout(this.noticeTimer)
    this.noticeEl.hidden = true
  }

  // --- Documents: samples, opened files, autosave -----------------------------------------------

  /** Playground, first load: the notebook that was open last time, else the first sample. */
  async start(): Promise<void> {
    const last = currentDocId()
    const known = last && (last === FILE_DOC ? loadDoc(FILE_DOC) !== null : samples.some((s) => `sample:${s.file}` === last))
    await this.openDoc(known ? last : `sample:${samples[0].file}`)
  }

  /** Show a notebook (remote and review modes). Python is stopped: another notebook starts with a clean memory. */
  show(notebook: Notebook, name: string): void {
    this.setNotebook(notebook, FILE_DOC, name)
  }

  /** The notebook as it is on the page. */
  get current(): Notebook {
    return this.notebook
  }

  get fileName(): string {
    return this.docName
  }

  setHeading(text: string): void {
    this.headingEl.textContent = text
  }

  private fillSelect(): void {
    if (!this.isPlayground) return
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
    if (this.destroyed) return
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
    if (this.destroyed) return
    const name = file.name.toLowerCase().endsWith('.ipynb') ? file.name : `${file.name}.ipynb`
    if (this.isPlayground) {
      this.saveNow()
      this.setNotebook(notebook, FILE_DOC, name)
      this.saveNow(true)
    } else {
      this.setNotebook(notebook, FILE_DOC, name)
      this.options.onFileOpened?.(name)
      this.options.onChanged?.()
    }
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
    if (this.isPlayground) document.title = `${name} · Notebook Lab`
    this.showChecks()
    window.scrollTo({ top: 0 })
  }

  changed(): void {
    if (this.destroyed) return
    if (!this.isPlayground) {
      this.options.onChanged?.()
      return
    }
    this.showSave('pending')
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.saveNow(), 600)
  }

  /** Playground: write the notebook to localStorage now, if there is something to write. */
  private saveNow(force = false): void {
    if (!this.isPlayground || this.destroyed) return
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

  /** The notebook on the page as `.ipynb` text, as "Download" saves it. */
  serialize(): string {
    return serializeNotebook(this.notebook, { redact: secrets() })
  }

  private download(): void {
    const text = this.options.downloadText?.() ?? this.serialize()
    downloadBlob(new Blob([text], { type: 'application/x-ipynb+json' }), this.docName)
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
    this.notify('Cell deleted.', [{ label: 'Undo', run: () => this.undoDelete() }])
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

  /** True while a cell is running or waiting to run. */
  get busy(): boolean {
    return this.running !== null || this.queue.length > 0
  }

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
      if (this.destroyed) return
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
