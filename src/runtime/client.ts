/**
 * The page's handle on the Python worker: start, restart, run one cell at a time, and pass the
 * worker's requests for page-only services (audio, the token dialog, hosted models) to the host.
 */
import { config } from '../config.ts'
import type { DisplayOutput } from '../notebook/ipynb.ts'
import { answerHostRequest } from './host.ts'
import type { MainToWorker, RunError, RuntimeInfo, Status, WorkerToMain } from './protocol.ts'
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

export class Runtime {
  state: RuntimeState = 'stopped'
  info: RuntimeInfo | null = null
  private worker: Worker | null = null
  private ready: Promise<void> | null = null
  private active: ActiveRun | null = null
  private nextRunId = 1
  private failure = ''

  constructor(private events: RuntimeEvents) {
    onTokenChange((set) => this.send({ type: 'token-state', set }))
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
      worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
        if (this.worker !== worker) return
        const message = event.data
        switch (message.type) {
          case 'status':
            if (this.state !== 'failed') this.events.status(message.status, this.state)
            break
          case 'ready':
            this.state = 'ready'
            this.info = message.info
            resolve()
            break
          case 'fatal':
            fail(message.message)
            break
          case 'stream':
            if (this.active?.id === message.runId) this.active.handlers.stream(message.name, message.text)
            break
          case 'display':
            if (this.active?.id === message.runId) this.active.handlers.display(message.output)
            break
          case 'done':
            if (this.active?.id === message.runId) {
              const run = this.active
              this.active = null
              run.finish(message.error)
            }
            break
          case 'host-request':
            void answerHostRequest(message.method, message.params).then(
              ({ result, transfer }) => worker.postMessage({ type: 'host-response', id: message.id, ok: true, result }, transfer),
              (err: Error) =>
                worker.postMessage({
                  type: 'host-response',
                  id: message.id,
                  ok: false,
                  name: err.name || 'LabError',
                  message: err.message,
                } satisfies MainToWorker),
            )
            break
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
