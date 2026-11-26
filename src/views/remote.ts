/**
 * A notebook view whose notebook lives on the server: a student's copy of an assignment, or a
 * teacher's starter. This wires the view to the autosave (src/sync.ts): what the save state says,
 * what happens on a conflict, and which copy to show when this browser has unsaved work.
 */
import { MAX_NOTEBOOK_BYTES } from '../../shared/limits.ts'
import type { SaveResult, StoredNotebook } from '../api.ts'
import { describeDropped, describeSize, fitNotebook } from '../notebook/fit.ts'
import { notebookFromObject, parseNotebook, type Notebook } from '../notebook/ipynb.ts'
import { secrets } from '../runtime/token.ts'
import { deleteRemoteCopy, loadRemoteCopy } from '../storage.ts'
import { RemoteSync, type SyncState } from '../sync.ts'
import { formatDateTime } from '../ui/dom.ts'
import { NotebookView, type NotebookOptions } from './notebook.ts'

export interface RemoteSource {
  /** The slot of the copy in this browser (storage.ts, remoteKey). */
  key: string
  load(): Promise<StoredNotebook>
  save(text: string, version: number, name: string): Promise<SaveResult>
  /** Who sees the server's copy, for the note about outputs that were left out: "your teacher", "students". */
  reader: string
}

export class RemoteNotebook {
  readonly view: NotebookView
  private sync: RemoteSync | null = null
  private droppedShown = ''
  private destroyed = false

  constructor(
    private readonly source: RemoteSource,
    options: Omit<NotebookOptions, 'mode' | 'onChanged'>,
    private readonly onState: (state: SyncState) => void = () => {},
  ) {
    this.view = new NotebookView({ ...options, mode: 'remote', onChanged: () => this.sync?.changed() })
    const flush = () => this.sync?.writeLocal()
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', flush)
    this.stopListening = () => {
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }

  private readonly stopListening: () => void

  /** Load the notebook from the server and show it, or this browser's copy if that has unsaved work. Throws if the server cannot be asked. */
  async start(): Promise<void> {
    const stored = await this.source.load()
    if (this.destroyed) return
    const server = notebookFromObject(stored.notebook)
    const local = loadRemoteCopy(this.source.key)
    let notebook = server
    let name = stored.name
    let dirty = false
    let conflict: { version: number; updatedAt: number } | undefined
    if (local?.dirty) {
      let mine: Notebook | null = null
      try {
        mine = parseNotebook(local.text)
      } catch {
        mine = null
      }
      // The same content as on the server (a save went through just before the tab was closed): nothing to do.
      const same = mine !== null && fitNotebook(mine, MAX_NOTEBOOK_BYTES, secrets()).text === JSON.stringify(stored.notebook)
      if (mine && !same) {
        notebook = mine
        name = local.name
        if (local.baseVersion === stored.version) dirty = true
        else conflict = { version: stored.version, updatedAt: stored.updatedAt }
      }
    }
    this.view.show(notebook, name)
    this.attach(stored.version, dirty, conflict)
    if (dirty) this.view.notify('Changes that were only saved in this browser were restored and are being saved on the server.')
  }

  private attach(version: number, dirty: boolean, conflict?: { version: number; updatedAt: number }): void {
    this.sync?.dispose()
    this.sync = new RemoteSync({
      key: this.source.key,
      name: () => this.view.fileName,
      version,
      dirty,
      conflict,
      notebook: () => this.view.current,
      redact: secrets,
      save: (text, v) => this.source.save(text, v, this.view.fileName),
      onState: (state) => this.show(state),
    })
    this.show(this.sync.current)
  }

  private show(state: SyncState): void {
    if (this.destroyed) return
    const view = this.view
    const n = state.dropped.length
    switch (state.status) {
      case 'saved':
        view.showSave('saved', n > 0 ? `Saved on the server without ${n} large output${n === 1 ? '' : 's'}` : 'Saved on the server', n > 0 ? `Left out: ${describeDropped(state.dropped)}` : '')
        break
      case 'pending':
      case 'saving':
        view.showSave('pending', 'Saving…')
        break
      case 'offline':
        view.showSave(
          'offline',
          state.local === 'none'
            ? 'Not saved: the server cannot be reached and browser storage is unavailable. Download the notebook to keep it.'
            : `Saved in this browser${state.local === 'without-outputs' ? ' (without outputs)' : ''}. ${state.message ? `Not on the server yet: ${state.message}` : 'The server cannot be reached; trying again.'}`,
        )
        break
      case 'conflict':
        view.showSave('conflict', 'Not saved on the server: a newer version exists')
        break
      case 'failed':
        view.showSave('failed', state.message)
        break
    }
    if (state.status === 'conflict' && state.conflict) {
      view.notify(
        `This notebook was saved somewhere else (another tab or device) on ${formatDateTime(state.conflict.updatedAt)}, after this page loaded it. Which version do you want to keep?`,
        [
          { label: 'Keep mine', run: () => void this.sync?.keepMine() },
          { label: 'Load the newer one', run: () => void this.loadNewer() },
        ],
        true,
      )
    }
    // Say once which outputs the server's copy leaves out, and again when the list changes.
    const signature = state.dropped.map((d) => `${d.cell}:${d.kind}:${d.bytes}`).join('|')
    if (state.status === 'saved' && signature !== this.droppedShown) {
      this.droppedShown = signature
      if (n > 0) {
        view.notify(
          `Not saved on the server: ${describeDropped(state.dropped)}. A stored notebook is limited to ${describeSize(MAX_NOTEBOOK_BYTES)}, so the largest pictures and sound are left out; ` +
            `code and text are always saved. They stay on this page and in the file you download. In their place ${this.source.reader} a note, and can run the cell to make them again.`,
        )
      }
    }
    this.onState(state)
  }

  private async loadNewer(): Promise<void> {
    try {
      const stored = await this.source.load()
      if (this.destroyed) return
      this.sync?.dispose()
      this.sync = null
      deleteRemoteCopy(this.source.key)
      this.view.show(notebookFromObject(stored.notebook), stored.name)
      this.attach(stored.version, false)
    } catch (err) {
      this.view.notify(`The newer version could not be loaded: ${(err as Error).message}`, [{ label: 'Try again', run: () => void this.loadNewer() }], true)
    }
  }

  /** Save now. Resolves true when the server has the notebook exactly as it is on the page. */
  async flush(): Promise<boolean> {
    return this.sync ? this.sync.flush() : false
  }

  get version(): number {
    return this.sync?.currentVersion ?? 0
  }

  get state(): SyncState | null {
    return this.sync?.current ?? null
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopListening()
    this.sync?.dispose()
    this.view.destroy()
  }
}
