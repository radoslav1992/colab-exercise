/** One cell on the page: its editor, its buttons, its outputs and (for check cells) its badge. */
import type { EditorView } from '@codemirror/view'
import { CHECK_TAG, checkState, hasTag, type Cell, type Output, type StreamOutput } from '../notebook/ipynb.ts'
import { renderMarkdown } from '../notebook/markdown.ts'
import { createEditor } from './editor.ts'
import { icon, type IconName } from './icons.ts'
import { renderOutput, streamText } from './output.ts'

export type RunState = 'idle' | 'queued' | 'running'

export interface CellHost {
  run(view: CellView, advance: boolean): void
  /** The cell's source, type, tags or outputs changed: save. */
  changed(): void
  remove(view: CellView): void
  move(view: CellView, delta: -1 | 1): void
  insertAfter(view: CellView, type: 'code' | 'markdown'): void
  convert(view: CellView): void
  toggleCheck(view: CellView): void
}

function button(label: string, iconName: IconName, className = 'icon-button'): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.setAttribute('aria-label', label)
  node.title = label
  node.append(icon(iconName))
  return node
}

function textButton(label: string, className: string, iconName?: IconName): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  if (iconName) node.append(icon(iconName))
  node.append(label)
  return node
}

export class CellView {
  readonly root = document.createElement('section')
  state: RunState = 'idle'
  private editor: EditorView | null = null
  private readonly editorHost = document.createElement('div')
  private readonly rendered = document.createElement('div')
  private readonly outputsEl = document.createElement('div')
  private readonly badge = document.createElement('p')
  private readonly count = document.createElement('span')
  private readonly primary: HTMLButtonElement
  private readonly checkToggle: HTMLButtonElement
  private readonly convertButton: HTMLButtonElement
  private readonly upButton: HTMLButtonElement
  private readonly downButton: HTMLButtonElement
  private outputEls: HTMLElement[] = []
  private streamFrame = 0
  /** Markdown cells only: showing the editor instead of the rendered text. */
  private editing = false

  constructor(
    readonly cell: Cell,
    private readonly host: CellHost,
  ) {
    const isCode = cell.cell_type === 'code'
    this.root.className = `cell cell-${cell.cell_type}`
    this.root.dataset.cellId = cell.id

    // Left: the run (or edit) button and the execution count.
    const side = document.createElement('div')
    side.className = 'cell-side'
    this.primary = button('Run cell', 'play', 'icon-button run-button')
    this.primary.addEventListener('click', () => this.primaryAction())
    this.count.className = 'cell-count'
    side.append(this.primary, this.count)

    // Right: tools, editor, badge, outputs.
    const body = document.createElement('div')
    body.className = 'cell-body'

    const tools = document.createElement('div')
    tools.className = 'cell-tools'
    tools.setAttribute('role', 'toolbar')
    tools.setAttribute('aria-label', 'Cell actions')
    this.checkToggle = textButton('Check', 'tool-button check-toggle', 'check')
    this.checkToggle.title = 'Check cell: shows passed or failed after it runs'
    this.checkToggle.addEventListener('click', () => this.host.toggleCheck(this))
    this.convertButton = textButton('', 'tool-button')
    this.convertButton.addEventListener('click', () => this.host.convert(this))
    this.upButton = button('Move cell up', 'up', 'tool-button')
    this.upButton.addEventListener('click', () => this.host.move(this, -1))
    this.downButton = button('Move cell down', 'down', 'tool-button')
    this.downButton.addEventListener('click', () => this.host.move(this, 1))
    const deleteButton = button('Delete cell', 'trash', 'tool-button')
    deleteButton.addEventListener('click', () => this.host.remove(this))
    tools.append(this.checkToggle, this.convertButton, this.upButton, this.downButton, deleteButton)

    this.editorHost.className = 'cell-editor'
    this.rendered.className = 'markdown cell-rendered'
    this.rendered.addEventListener('dblclick', () => this.edit())
    this.badge.className = 'cell-check'
    this.badge.setAttribute('role', 'status')
    this.outputsEl.className = 'cell-outputs'
    this.outputsEl.setAttribute('role', 'group')
    this.outputsEl.setAttribute('aria-label', 'Output')
    body.append(tools, this.editorHost, this.rendered, this.badge, this.outputsEl)

    // Below: add a cell after this one.
    const add = document.createElement('div')
    add.className = 'cell-add'
    const addCode = textButton('Code', 'add-button', 'plus')
    addCode.setAttribute('aria-label', 'Add a code cell below')
    addCode.addEventListener('click', () => this.host.insertAfter(this, 'code'))
    const addText = textButton('Text', 'add-button', 'plus')
    addText.setAttribute('aria-label', 'Add a text cell below')
    addText.addEventListener('click', () => this.host.insertAfter(this, 'markdown'))
    add.append(addCode, addText)

    const row = document.createElement('div')
    row.className = 'cell-row'
    row.append(side, body)
    this.root.append(row, add)

    if (isCode) {
      this.mountEditor()
      this.rendered.hidden = true
      for (const output of cell.outputs) this.pushOutputElement(output)
    } else {
      this.outputsEl.hidden = true
      this.editing = cell.source.trim() === ''
      if (this.editing) this.mountEditor()
    }
    this.refresh()
  }

  // --- Layout and labels --------------------------------------------------------------------------

  /** Called by the page when cells are added, removed or moved. */
  setPosition(index: number, total: number): void {
    const kind = this.cell.cell_type === 'code' ? 'Code' : this.cell.cell_type === 'markdown' ? 'Text' : 'Raw'
    this.root.setAttribute('aria-label', `${kind} cell ${index + 1} of ${total}`)
    this.upButton.disabled = index === 0
    this.downButton.disabled = index === total - 1
  }

  /** Bring buttons, count, badge and the rendered Markdown in line with the cell. */
  refresh(): void {
    const { cell } = this
    const isCode = cell.cell_type === 'code'
    this.root.classList.toggle('is-running', this.state === 'running')
    this.root.classList.toggle('is-queued', this.state === 'queued')

    if (isCode) {
      const busy = this.state !== 'idle'
      this.primary.replaceChildren(icon(busy ? 'spinner' : 'play'))
      const label = this.state === 'running' ? 'Cell is running' : this.state === 'queued' ? 'Cell is waiting to run' : 'Run cell'
      this.primary.setAttribute('aria-label', label)
      this.primary.title = busy ? label : 'Run cell (Shift+Enter)'
      // Not `disabled`: a disabled button would drop the keyboard focus while the cell runs.
      this.primary.setAttribute('aria-disabled', String(busy))
      this.count.textContent = this.state === 'running' ? '[*]' : `[${cell.execution_count ?? ' '}]`
      this.count.setAttribute(
        'aria-label',
        cell.execution_count === null ? 'Not run yet' : `Execution count ${cell.execution_count}`,
      )
    } else {
      this.primary.replaceChildren(icon(this.editing ? 'done' : 'edit'))
      const label = this.editing ? 'Show the formatted text' : 'Edit text'
      this.primary.setAttribute('aria-label', label)
      this.primary.title = this.editing ? 'Show the formatted text (Shift+Enter)' : label
      this.count.textContent = ''
      this.editorHost.hidden = !this.editing
      this.rendered.hidden = this.editing
      if (!this.editing) {
        this.rendered.innerHTML = cell.cell_type === 'markdown' ? renderMarkdown(cell.source) : ''
        if (cell.cell_type === 'raw') this.rendered.textContent = cell.source
      }
    }

    const isCheck = isCode && hasTag(cell, CHECK_TAG)
    this.checkToggle.hidden = !isCode
    this.checkToggle.setAttribute('aria-pressed', String(isCheck))
    this.convertButton.textContent = isCode ? 'To text' : 'To code'
    this.convertButton.setAttribute('aria-label', isCode ? 'Change to a text cell' : 'Change to a code cell')
    this.root.classList.toggle('is-check', isCheck)
    this.badge.hidden = !isCheck
    if (isCheck) {
      const state = this.state === 'idle' ? checkState(cell) : 'running'
      this.badge.dataset.state = state
      const text = {
        'not-run': 'Check: not run yet',
        running: 'Check: running…',
        passed: 'Check passed',
        failed: 'Check failed',
      }[state]
      const iconName: IconName = state === 'passed' ? 'check' : state === 'failed' ? 'cross' : 'dot'
      this.badge.replaceChildren(icon(iconName), text)
    }
  }

  // --- Editing -----------------------------------------------------------------------------------

  private mountEditor(): void {
    if (this.editor) return
    this.editor = createEditor(this.editorHost, {
      doc: this.cell.source,
      language: this.cell.cell_type === 'code' ? 'python' : 'markdown',
      label: this.cell.cell_type === 'code' ? 'Python code' : 'Markdown text',
      onChange: (doc) => {
        this.cell.source = doc
        this.host.changed()
      },
      onRun: (advance) => this.host.run(this, advance),
      onEscape: () => this.primary.focus(),
    })
  }

  private primaryAction(): void {
    if (this.cell.cell_type === 'code') this.host.run(this, false)
    else if (this.editing) this.host.run(this, false)
    else this.edit()
  }

  /** Markdown cells: switch to the editor. */
  edit(): void {
    if (this.cell.cell_type === 'code') return
    this.editing = true
    this.mountEditor()
    this.refresh()
    this.editor?.focus()
  }

  /** Markdown cells: show the formatted text. */
  render(): void {
    if (this.cell.cell_type === 'code') return
    this.editing = false
    this.refresh()
  }

  focusEditor(): void {
    if (this.editor && !this.editorHost.hidden) this.editor.focus()
    else this.primary.focus()
  }

  focusPrimary(): void {
    this.primary.focus()
  }

  destroy(): void {
    cancelAnimationFrame(this.streamFrame)
    this.editor?.destroy()
    this.root.remove()
  }

  // --- Outputs -----------------------------------------------------------------------------------

  private pushOutputElement(output: Output): void {
    const node = renderOutput(output)
    this.outputEls.push(node)
    this.outputsEl.append(node)
  }

  clearOutputs(): void {
    this.cell.outputs = []
    this.outputEls = []
    this.outputsEl.replaceChildren()
  }

  appendOutput(output: Output): void {
    this.cell.outputs.push(output)
    this.pushOutputElement(output)
  }

  /** Text for stdout or stderr: joined to the previous output if that is the same stream, as Jupyter does. */
  appendStream(name: 'stdout' | 'stderr', text: string): void {
    const outputs = this.cell.outputs
    const last = outputs[outputs.length - 1]
    if (last && last.output_type === 'stream' && (last as StreamOutput).name === name) {
      ;(last as StreamOutput).text += text
      // Many small writes become one update of the page per frame.
      if (!this.streamFrame) {
        this.streamFrame = requestAnimationFrame(() => {
          this.streamFrame = 0
          const current = this.cell.outputs[this.cell.outputs.length - 1]
          const node = this.outputEls[this.outputEls.length - 1]
          if (current && current.output_type === 'stream' && node) node.textContent = streamText(current as StreamOutput)
        })
      }
    } else {
      this.flushStream()
      this.appendOutput({ output_type: 'stream', name, text })
    }
  }

  /** Make the page show all stream text now (before another output is added, and when the cell ends). */
  flushStream(): void {
    if (this.streamFrame) {
      cancelAnimationFrame(this.streamFrame)
      this.streamFrame = 0
    }
    const index = this.cell.outputs.length - 1
    const current = this.cell.outputs[index]
    const node = this.outputEls[index]
    if (current && current.output_type === 'stream' && node) node.textContent = streamText(current as StreamOutput)
  }
}
