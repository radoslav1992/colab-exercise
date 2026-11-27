/// <reference lib="webworker" />
/**
 * The worker that runs Python. Pyodide, the `lab` package and the model libraries all live here,
 * so a long computation never freezes the page. "Restart runtime" on the page simply terminates
 * this worker and starts a new one.
 */
import type { PyodideAPI } from 'pyodide'
import type { DisplayOutput } from '../notebook/ipynb.ts'
import { createBridge, probeDevice, type Bridge } from './bridge.ts'
import type { HostMethod, MainToWorker, RunError, Status, WorkerToMain } from './protocol.ts'
import { NamedError } from './protocol.ts'

declare const self: DedicatedWorkerGlobalScope

// The Python sources of the `lab` package, bundled as text and written into Pyodide's file system.
const labSources = import.meta.glob('../../python/lab/*.py', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>

function post(message: WorkerToMain, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer)
}

function status(next: Status): void {
  post({ type: 'status', status: next })
}

let pyodide: PyodideAPI | null = null
let bridge: Bridge | null = null
let runCell: ((source: string, label: number) => Promise<string>) | null = null
let currentRun = 0
let numpy: Promise<boolean> | null = null

// --- Requests to the page -----------------------------------------------------------------------

let nextHostId = 1
const hostWaiters = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>()

function host(method: HostMethod, params: unknown, transfer: Transferable[] = []): Promise<unknown> {
  const id = nextHostId++
  return new Promise((resolve, reject) => {
    hostWaiters.set(id, { resolve, reject })
    post({ type: 'host-request', id, method, params }, transfer)
  })
}

// --- Packages -----------------------------------------------------------------------------------

class PackageError extends Error {}

/**
 * Pyodide reports a failed download through the error callback and carries on, so the failures
 * are collected here and turned into one clear error.
 */
async function loadPackages(load: (callbacks: { messageCallback(m: string): void; errorCallback(m: string): void }) => Promise<unknown>): Promise<void> {
  const failed: string[] = []
  const errors: string[] = []
  await load({
    messageCallback(message) {
      const loading = /^Loading (.+)$/.exec(message)
      if (loading) status({ kind: 'package', text: `Loading package ${loading[1]}` })
      const failure = /^Failed to load (.+)$/.exec(message)
      if (failure) failed.push(failure[1])
    },
    errorCallback(message) {
      errors.push(message)
    },
  })
  if (failed.length > 0 || errors.length > 0) {
    const names = failed.length > 0 ? failed.join(', ') : 'a package'
    const detail = errors.filter((line) => !line.startsWith('The following error occurred')).join(' ')
    throw new PackageError(
      `Could not load the Python package ${names}. It is downloaded the first time it is imported, ` +
        `so check your internet connection and run the cell again.${detail ? ` (${detail})` : ''}`,
    )
  }
}

function ensureNumpy(): Promise<boolean> {
  if (!numpy) {
    const py = pyodide!
    numpy = loadPackages((callbacks) => py.loadPackage('numpy', callbacks)).then(
      () => true,
      () => {
        numpy = null
        return false
      },
    )
  }
  return numpy
}

// --- Start --------------------------------------------------------------------------------------

async function boot(message: Extract<MainToWorker, { type: 'init' }>): Promise<void> {
  const { config } = message
  status({ kind: 'loading', text: 'Loading Python (Pyodide)' })
  const indexURL = new URL(config.pyodideIndexUrl, self.location.href).href
  const mod = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as typeof import('pyodide')
  const py = await mod.loadPyodide({
    indexURL,
    // Before sys.stdout is replaced below, and for output written by C code.
    stdout: (line) => bridge?.stream('stdout', line + '\n'),
    stderr: (line) => bridge?.stream('stderr', line + '\n'),
    // matplotlib must not look for a window system.
    env: { MPLBACKEND: 'AGG' },
  })
  pyodide = py

  status({ kind: 'loading', text: 'Starting the notebook runtime' })
  const device = await probeDevice(self)
  const python = String(py.runPython('import platform; platform.python_version()'))
  bridge = createBridge(
    {
      config,
      importModule: (url) => import(/* @vite-ignore */ new URL(url, self.location.href).href),
      host,
      status,
      stream: (name, text) => post({ type: 'stream', runId: currentRun, name, text }),
      display: (output: DisplayOutput) => post({ type: 'display', runId: currentRun, output }),
      ensureNumpy,
      runtime: { pyodide: py.version, python },
    },
    device,
    message.tokenSet,
  )
  py.registerJsModule('_lab_js', bridge)

  const sitePackages = String(py.runPython('import sysconfig; sysconfig.get_path("purelib")'))
  py.FS.mkdirTree(`${sitePackages}/lab`)
  for (const [path, source] of Object.entries(labSources)) {
    py.FS.writeFile(`${sitePackages}/lab/${path.split('/').pop()}`, source)
  }
  const run = py.runPython(`
import importlib
importlib.invalidate_caches()
from lab import _runtime
_runtime.install()
_runtime.run_cell
`) as (source: string, label: number) => Promise<string>
  runCell = run

  post({ type: 'ready', info: { pyodide: py.version, python, jspi: device.jspi, webgpu: device.webgpu } })
  status({ kind: 'idle', text: 'Idle' })
}

// --- Running cells ------------------------------------------------------------------------------

async function run(message: Extract<MainToWorker, { type: 'run' }>): Promise<void> {
  const py = pyodide
  if (!py || !runCell || !bridge) {
    post({ type: 'done', runId: message.runId, error: { ename: 'RuntimeError', evalue: 'Python is not running', traceback: [] } })
    return
  }
  currentRun = message.runId
  status({ kind: 'running', text: 'Running' })
  let error: RunError | null = null
  try {
    // Packages that ship with Pyodide (numpy, matplotlib, micropip, ...) are fetched when a cell first imports them.
    await loadPackages((callbacks) => py.loadPackagesFromImports(message.code, callbacks))
    status({ kind: 'running', text: 'Running' })
    const result = JSON.parse(await runCell(message.code, message.label)) as { ok: boolean } & Partial<RunError>
    if (!result.ok) {
      error = { ename: result.ename ?? 'Error', evalue: result.evalue ?? '', traceback: result.traceback ?? [] }
    }
  } catch (err) {
    const text = String((err as Error)?.message ?? err)
    error =
      err instanceof PackageError
        ? { ename: 'PackageLoadError', evalue: text, traceback: [`PackageLoadError: ${text}`] }
        : { ename: 'RuntimeError', evalue: text, traceback: [`The notebook runtime failed: ${text}`] }
  }
  bridge.flush()
  post({ type: 'done', runId: message.runId, error })
  status({ kind: 'idle', text: 'Idle' })
}

// Cells run one after the other, in the order they were sent.
let queue: Promise<void> = Promise.resolve()

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  const message = event.data
  switch (message.type) {
    case 'init':
      queue = queue.then(() =>
        boot(message).catch((err: unknown) => {
          post({ type: 'fatal', message: String((err as Error)?.message ?? err) })
        }),
      )
      break
    case 'run':
      queue = queue.then(() => run(message))
      break
    case 'host-response': {
      const waiter = hostWaiters.get(message.id)
      if (!waiter) break
      hostWaiters.delete(message.id)
      if (message.ok) waiter.resolve(message.result)
      else waiter.reject(new NamedError(message.name as 'LabError', message.message))
      break
    }
    case 'token-state':
      bridge?.setTokenState(message.set)
      break
  }
}
