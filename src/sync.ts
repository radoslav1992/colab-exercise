/**
 * Autosave of a notebook that lives on the server (a student's copy of an assignment, a teacher's
 * starter), on top of the copy in this browser.
 *
 * Every change is written to localStorage after a moment (so work survives a closed tab and being
 * offline) and sent to the server a little later. The server takes a save only on top of the
 * version this page has; if another tab or device saved in between, it answers 409 and the person
 * chooses: keep mine, or load the newer one. While the server cannot be reached, the copy in this
 * browser is the truth and saving is tried again, also when the browser reports being online.
 */
import { MAX_NOTEBOOK_BYTES } from '../shared/limits.ts'
import { ApiError, type SaveResult } from './api.ts'
import { describeSize, fitNotebook, type DroppedOutput } from './notebook/fit.ts'
import { serializeNotebook, type Notebook } from './notebook/ipynb.ts'
import { saveRemoteCopy } from './storage.ts'

export type SyncStatus = 'saved' | 'pending' | 'saving' | 'offline' | 'conflict' | 'failed'

export interface SyncState {
  status: SyncStatus
  /** Why saving failed, in words for the person. */
  message: string
  /** Binary outputs that the server's copy leaves out because of the size limit. */
  dropped: DroppedOutput[]
  /** The server's newer version, while there is a conflict. */
  conflict: { version: number; updatedAt: number } | null
  /** False when even this browser could not keep a full copy (storage is full or blocked). */
  local: 'full' | 'without-outputs' | 'none'
}

export interface SyncOptions {
  /** The slot of the local copy (storage.ts, remoteKey). */
  key: string
  name: () => string
  /** The version of the server's copy that the notebook on the page is based on. */
  version: number
  /** The page starts with changes that the server does not have (restored from this browser). */
  dirty?: boolean
  conflict?: { version: number; updatedAt: number }
  notebook: () => Notebook
  /** Secrets (the Hugging Face token) that must not be written anywhere. */
  redact: () => string[]
  save: (text: string, version: number) => Promise<SaveResult>
  onState: (state: SyncState) => void
}

const LOCAL_DELAY = 600
const SERVER_DELAY = 1500
/** While the person keeps typing, the server still gets a save this often. */
const SERVER_MAX_WAIT = 8000
const RETRY_FIRST = 4000
const RETRY_MAX = 60_000

export class RemoteSync {
  private version: number
  private revision = 0
  private savedRevision = 0
  private state: SyncState
  private localTimer = 0
  private serverTimer = 0
  private firstUnsaved = 0
  private retryDelay = RETRY_FIRST
  private inFlight: Promise<void> | null = null
  private disposed = false
  private readonly online = () => {
    if (this.state.status === 'offline') void this.push()
  }

  constructor(private readonly options: SyncOptions) {
    this.version = options.version
    this.state = { status: 'saved', message: '', dropped: [], conflict: options.conflict ?? null, local: 'full' }
    window.addEventListener('online', this.online)
    if (options.conflict) {
      this.revision = 1
      this.set({ status: 'conflict' })
    } else if (options.dirty) {
      this.revision = 1
      this.set({ status: 'pending' })
      this.schedule(0)
    }
  }

  get currentVersion(): number {
    return this.version
  }

  get current(): SyncState {
    return this.state
  }

  /** True while the server does not have the notebook as it is on the page. */
  get unsynced(): boolean {
    return this.revision !== this.savedRevision
  }

  private set(change: Partial<SyncState>): void {
    this.state = { ...this.state, ...change }
    if (!this.disposed) this.options.onState(this.state)
  }

  private schedule(delay: number): void {
    window.clearTimeout(this.serverTimer)
    if (this.disposed) return
    this.serverTimer = window.setTimeout(() => void this.push(), delay)
  }

  /** The notebook on the page changed. */
  changed(): void {
    this.revision += 1
    window.clearTimeout(this.localTimer)
    this.localTimer = window.setTimeout(() => this.writeLocal(), LOCAL_DELAY)
    if (this.state.status === 'conflict') return
    if (this.state.status !== 'saving') this.set({ status: 'pending', message: '' })
    const now = Date.now()
    if (!this.firstUnsaved) this.firstUnsaved = now
    this.schedule(Math.max(0, Math.min(SERVER_DELAY, this.firstUnsaved + SERVER_MAX_WAIT - now)))
  }

  /** Write the copy in this browser now (also called when the tab is hidden or closed). */
  writeLocal(): void {
    window.clearTimeout(this.localTimer)
    this.localTimer = 0
    const { key, name, notebook, redact } = this.options
    const copy = { name: name(), baseVersion: this.version, dirty: this.unsynced }
    let local: SyncState['local'] = 'full'
    if (!saveRemoteCopy(key, { ...copy, text: serializeNotebook(notebook(), { redact: redact() }) })) {
      local = saveRemoteCopy(key, { ...copy, text: serializeNotebook(notebook(), { redact: redact(), withoutOutputs: true }) }) ? 'without-outputs' : 'none'
    }
    if (local !== this.state.local) this.set({ local })
  }

  /** Send the notebook to the server now, unless that is pointless (a conflict is waiting for an answer). */
  private push(): Promise<void> {
    if (this.inFlight) return this.inFlight.then(() => (this.unsynced && this.state.status === 'pending' ? this.push() : undefined))
    if (this.state.status === 'conflict' || !this.unsynced) return Promise.resolve()
    window.clearTimeout(this.serverTimer)
    this.inFlight = this.send().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async send(): Promise<void> {
    const revision = this.revision
    const fit = fitNotebook(this.options.notebook(), MAX_NOTEBOOK_BYTES, this.options.redact())
    if (!fit.fits) {
      this.writeLocal()
      this.set({
        status: 'failed',
        dropped: fit.dropped,
        message: `Not saved on the server: this notebook is ${describeSize(fit.bytes)} even without its pictures and sound, and the limit is ${describeSize(MAX_NOTEBOOK_BYTES)}. Clear some outputs or shorten the text.`,
      })
      return
    }
    this.set({ status: 'saving', message: '' })
    try {
      const result = await this.options.save(fit.text, this.version)
      this.version = result.version
      this.savedRevision = revision
      this.retryDelay = RETRY_FIRST
      this.firstUnsaved = this.unsynced ? Date.now() : 0
      this.writeLocal()
      this.set({ status: this.unsynced ? 'pending' : 'saved', dropped: fit.dropped, conflict: null })
      if (this.unsynced) this.schedule(SERVER_DELAY)
    } catch (err) {
      this.writeLocal()
      const error = err instanceof ApiError ? err : new ApiError(0, String((err as Error)?.message ?? err))
      if (error.status === 409 && error.data.conflict === true) {
        this.set({ status: 'conflict', conflict: { version: Number(error.data.version), updatedAt: Number(error.data.updatedAt) } })
      } else if (error.temporary) {
        this.set({ status: 'offline', message: error.status === 0 ? '' : error.message })
        this.schedule(this.retryDelay)
        this.retryDelay = Math.min(RETRY_MAX, this.retryDelay * 2)
      } else if (error.status === 401) {
        this.set({ status: 'failed', message: 'You are signed out. Your work is kept in this browser; sign in again to save it on the server.' })
      } else {
        this.set({ status: 'failed', message: `Not saved on the server: ${error.message}` })
      }
    }
  }

  /** Save now. Resolves true when the server has the notebook exactly as it is on the page. */
  async flush(): Promise<boolean> {
    this.writeLocal()
    if (this.state.status === 'offline' || this.state.status === 'failed') this.set({ status: 'pending' })
    await this.push()
    return !this.unsynced && this.state.status === 'saved'
  }

  /** Conflict: keep what is on the page, and save it on top of the server's newer version. */
  async keepMine(): Promise<boolean> {
    if (!this.state.conflict) return this.flush()
    this.version = this.state.conflict.version
    this.revision += 1
    this.set({ status: 'pending', conflict: null })
    return this.flush()
  }

  /** The view is going away: write the local copy, try one last save, and stop reporting. */
  dispose(): void {
    if (this.disposed) return
    window.clearTimeout(this.localTimer)
    window.clearTimeout(this.serverTimer)
    window.removeEventListener('online', this.online)
    this.disposed = true
    if (this.unsynced) {
      this.writeLocal()
      if (this.state.status !== 'conflict') void this.push()
    }
  }
}
