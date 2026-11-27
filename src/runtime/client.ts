/**
 * The page's handle on the Python worker: start, restart, run one cell at a time, and pass the
 * worker's requests for page-only services (audio, the token dialog, hosted models) to the host.
 */
import { config } from '../config.ts'
import type { DisplayOutput } from '../notebook/ipynb.ts'
import { answerHostRequest } from './host.ts'
import { HOST_METHODS, type HostMethod, type MainToWorker, type RunError, type RuntimeInfo, type Status } from './protocol.ts'
import { hasToken, onTokenChange } from './token.ts'

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'failed'

export interface RunHandlers {
  stream(name: 'stdout' | 'stderr', text: string): void
  display(output: DisplayOutput): void
}

export interface RuntimeEvents {
  status(status: Status | null, state: RuntimeState, detail?: string): void
}

interface ActiveRun {
  id: number
  handlers: RunHandlers
  finish(error: RunError | null): void
}

const STATUS_KINDS = ['loading', 'package', 'download', 'running', 'idle']

function readStatus(value: unknown): Status | null {
  if (typeof value !== 'object' || value === null) return null
  const { kind, text, progress } = value as Record<string, unknown>
  if (typeof kind !== 'string' || !STATUS_KINDS.includes(kind) || typeof text !== 'string') return null
  const status: Status = { kind: kind as Status['kind'], text: text.slice(0, 500) }
  if (typeof progress === 'number' && Number.isFinite(progress)) status.progress = Math.min(1, Math.max(0, progress))
  return status
}

function readDisplay(value: unknown): DisplayOutput | null {
  if (typeof value !== 'object' || value === null) return null
  const { output_type, data, metadata } = value as Record<string, unknown>
  if (output_type !== 'display_data' && output_type !== 'execute_result') return null
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  return { output_type, data: isObject(data) ? data : {}, metadata: isObject(metadata) ? metadata : {} }
}

function readError(value: unknown): RunError | null {
  if (typeof value !== 'object' || value === null) return null
  const { ename, evalue, traceback } = value as Record<string, unknown>
  return {
    ename: String(ename ?? 'Error'),
    evalue: String(evalue ?? ''),
    traceback: Array.isArray(traceback) ? traceback.map((line) => String(line)) : [],
  }
}

export class Runtime {
  state: RuntimeState = 'stopped'
  info: RuntimeInfo | null = null
  private worker: Worker | null = null
  private ready: Promise<void> | null = null
  private active: ActiveRun | null = null
  private nextRunId = 1
  private failure = ''
  private readonly stopTokenUpdates: () => void

  constructor(private events: RuntimeEvents) {
    this.stopTokenUpdates = onTokenChange((set) => this.send({ type: 'token-state', set }))
  }

  /** Stop the worker for good (the notebook view is going away). */
  dispose(): void {
    this.stopTokenUpdates()
    this.stop()
  }

  private send(message: MainToWorker): void {
    this.worker?.postMessage(message)
  }

  /** Start the worker if it is not running. Resolves when Python is ready; rejects if it cannot start. */
  start(): Promise<void> {
    if (this.ready) return this.ready
    this.state = 'starting'
    this.events.status({ kind: 'loading', text: 'Starting Python' }, this.state)
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'python' })
    this.worker = worker
    this.ready = new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        if (this.worker !== worker) return
        this.state = 'failed'
        this.failure = message
        this.events.status(null, this.state, message)
        this.active?.finish({
          ename: 'RuntimeError',
          evalue: message,
          traceback: [`Python could not start: ${message}`],
        })
        this.active = null
        reject(new Error(message))
      }
      worker.onerror = (event) => {
        event.preventDefault()
        if (this.worker !== worker) return
        if (this.state === 'ready') {
          // An error outside a cell's own call stack (for example in a JavaScript callback that a
          // cell set up). Python is still alive: show it where the student looks, and carry on.
          const text = `Uncaught error in the runtime: ${event.message}\n`
          if (this.active) this.active.handlers.stream('stderr', text)
          else console.warn(text)
          return
        }
        fail(event.message || 'the worker script could not be loaded')
      }
      // Everything the worker says is untrusted: the worker runs the code of a notebook, and that
      // code can post any message it likes. Each message is checked field by field, unknown ones
      // are dropped, and nothing here (or in host.ts) reaches the site's API or the session.
      worker.onmessage = (event: MessageEvent<unknown>) => {
        if (this.worker !== worker) return
        const message = event.data as Record<string, unknown> | null
        if (typeof message !== 'object' || message === null) return
        switch (message.type) {
          case 'status': {
            const status = readStatus(message.status)
            if (status && this.state !== 'failed') this.events.status(status, this.state)
            break
          }
          case 'ready': {
            const info = message.info as Partial<RuntimeInfo> | null
            this.state = 'ready'
            this.info = {
              pyodide: String(info?.pyodide ?? '').slice(0, 40),
              python: String(info?.python ?? '').slice(0, 40),
              jspi: info?.jspi === true,
              webgpu: info?.webgpu === true,
            }
            resolve()
            break
          }
          case 'fatal':
            fail(String(message.message ?? 'the runtime stopped').slice(0, 2000))
            break
          case 'stream': {
            const run = this.active
            if (run && run.id === message.runId && typeof message.text === 'string') {
              run.handlers.stream(message.name === 'stderr' ? 'stderr' : 'stdout', message.text)
            }
            break
          }
          case 'display': {
            const run = this.active
            const output = readDisplay(message.output)
            if (output && run && run.id === message.runId) run.handlers.display(output)
            break
          }
          case 'done': {
            const run = this.active
            if (run && run.id === message.runId) {
              this.active = null
              run.finish(readError(message.error))
            }
            break
          }
          case 'host-request': {
            const id = message.id
            if (typeof id !== 'number') break
            const answer = (reply: MainToWorker, transfer: Transferable[] = []) => {
              if (this.worker === worker) worker.postMessage(reply, transfer)
            }
            if (!HOST_METHODS.includes(message.method as HostMethod)) {
              answer({ type: 'host-response', id, ok: false, name: 'LabError', message: 'lab: the page does not offer this.' })
              break
            }
            void answerHostRequest(message.method as HostMethod, message.params).then(
              ({ result, transfer }) => answer({ type: 'host-response', id, ok: true, result }, transfer),
              (err: unknown) =>
                answer({
                  type: 'host-response',
                  id,
                  ok: false,
                  name: (err as Error)?.name || 'LabError',
                  message: String((err as Error)?.message ?? err),
                }),
            )
            break
          }
        }
      }
    })
    // Whoever awaits start() gets the error; this keeps an unawaited start from being reported twice.
    this.ready.catch(() => {})
    this.send({ type: 'init', config, tokenSet: hasToken() })
    return this.ready
  }

  /** Run one cell. Resolves with null, or with the error the cell raised. Never rejects. */
  async run(code: string, label: number, handlers: RunHandlers): Promise<RunError | null> {
    try {
      await this.start()
    } catch {
      const message = this.failure || 'Python could not start'
      return {
        ename: 'RuntimeError',
        evalue: message,
        traceback: [
          `Python could not start: ${message}`,
          'Check your internet connection, then press "Restart" and run the cell again.',
        ],
      }
    }
    return new Promise((resolve) => {
      const id = this.nextRunId++
      this.active = { id, handlers, finish: resolve }
      this.send({ type: 'run', runId: id, code, label })
    })
  }

  /** Stop the worker. A cell that is running ends with an error that says so. */
  stop(reason = 'The runtime was restarted while this cell was running.'): void {
    this.worker?.terminate()
    this.worker = null
    this.ready = null
    this.info = null
    this.state = 'stopped'
    const run = this.active
    this.active = null
    run?.finish({ ename: 'RuntimeRestarted', evalue: reason, traceback: [reason] })
    this.events.status(null, this.state)
  }

  get busy(): boolean {
    return this.active !== null
  }
}
