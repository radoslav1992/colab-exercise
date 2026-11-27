/** Messages between the page (main thread) and the worker that runs Python. */
import type { RuntimeConfig } from '../config.ts'
import type { DisplayOutput } from '../notebook/ipynb.ts'

export type StatusKind = 'loading' | 'package' | 'download' | 'running' | 'idle'

export interface Status {
  kind: StatusKind
  /** One line for the status bar, for example "Loading package numpy". */
  text: string
  /** 0 to 1 when the step reports progress (model downloads). */
  progress?: number
}

export interface RunError {
  ename: string
  evalue: string
  traceback: string[]
}

export interface RuntimeInfo {
  pyodide: string
  python: string
  jspi: boolean
  webgpu: boolean
}

export type MainToWorker =
  | { type: 'init'; config: RuntimeConfig; tokenSet: boolean }
  | { type: 'run'; runId: number; code: string; label: number }
  | { type: 'host-response'; id: number; ok: true; result: unknown }
  | { type: 'host-response'; id: number; ok: false; name: string; message: string }
  | { type: 'token-state'; set: boolean }

export type WorkerToMain =
  | { type: 'status'; status: Status }
  | { type: 'ready'; info: RuntimeInfo }
  | { type: 'fatal'; message: string }
  | { type: 'stream'; runId: number; name: 'stdout' | 'stderr'; text: string }
  | { type: 'display'; runId: number; output: DisplayOutput }
  | { type: 'done'; runId: number; error: RunError | null }
  | { type: 'host-request'; id: number; method: HostMethod; params: unknown }

/** Things only the page can do; the worker asks for them (src/runtime/host.ts answers). */
export type HostMethod = 'audio.decode' | 'audio.record' | 'token.dialog' | 'inference'

/** An error with a name that the Python side maps to an exception class (python/lab/_bridge.py). */
export class NamedError extends Error {
  constructor(name: 'LabError' | 'PermissionError' | 'ValueError' | 'TypeError', message: string) {
    super(message)
    this.name = name
  }
}
