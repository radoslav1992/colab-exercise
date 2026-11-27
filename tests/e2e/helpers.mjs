/** Shared pieces of the end-to-end tests: finding Playwright, a tiny test runner, and page helpers. */
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Playwright is not a dependency of this project (its browsers are a large download). The tests use
 * an installed copy: `npm i -D playwright` here, a global install, or PLAYWRIGHT_PATH pointing at a
 * folder that contains node_modules/playwright.
 */
export function loadPlaywright() {
  const roots = [import.meta.url]
  if (process.env.PLAYWRIGHT_PATH) roots.push(join(process.env.PLAYWRIGHT_PATH, 'x.js'))
  try {
    roots.push(join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'x.js'))
  } catch {
    // No global npm root: only the local install can be used.
  }
  for (const root of roots) {
    try {
      return createRequire(root)('playwright')
    } catch {
      // Try the next place.
    }
  }
  throw new Error('Playwright was not found. Install it (npm i -D playwright && npx playwright install chromium) or set PLAYWRIGHT_PATH.')
}

export function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed: ${message}\n  expected ${e}\n  actual   ${a}`)
}

export function assertIncludes(text, part, message) {
  if (!String(text).includes(part)) throw new Error(`Assertion failed: ${message}\n  expected to find ${JSON.stringify(part)}\n  in ${JSON.stringify(String(text).slice(0, 600))}`)
}

export function assertExcludes(text, part, message) {
  if (String(text).includes(part)) throw new Error(`Assertion failed: ${message}\n  did not expect ${JSON.stringify(part)}`)
}

/** Collects tests and runs them one after the other. */
export class Suite {
  tests = []
  results = []
  test(name, fn) {
    this.tests.push({ name, fn })
  }
  async run(only) {
    for (const { name, fn } of this.tests) {
      if (only && !name.toLowerCase().includes(only.toLowerCase())) continue
      const started = Date.now()
      try {
        await fn()
        this.results.push({ name, ok: true })
        console.log(`  ok    ${name} (${Date.now() - started} ms)`)
      } catch (err) {
        this.results.push({ name, ok: false })
        console.log(`  FAIL  ${name}\n        ${String(err.stack ?? err).split('\n').join('\n        ')}`)
      }
    }
    const failed = this.results.filter((r) => !r.ok).length
    console.log(`\n${this.results.length - failed} passed, ${failed} failed`)
    return failed === 0
  }
}

let nextId = 1

/** Build a notebook object. A cell is a string of Python, or { md }, or { code, tags, id, metadata, outputs }. */
export function notebook(cells, extra = {}) {
  return {
    cells: cells.map((cell) => {
      if (typeof cell === 'string') cell = { code: cell }
      if (cell.md !== undefined) return { cell_type: 'markdown', id: cell.id ?? `md${nextId++}`, metadata: cell.metadata ?? {}, source: cell.md }
      const metadata = { ...(cell.metadata ?? {}) }
      if (cell.tags) metadata.tags = cell.tags
      return {
        cell_type: 'code',
        id: cell.id ?? `code${nextId++}`,
        metadata,
        execution_count: cell.execution_count ?? null,
        outputs: cell.outputs ?? [],
        source: cell.code,
      }
    }),
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
    ...extra,
  }
}

/** The playground (`url` is its address) in a new page, with a record of everything the console complained about. */
export async function openApp(context, url) {
  const page = await context.newPage()
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  await page.goto(url)
  await page.waitForSelector('.cell')
  return { page, problems }
}

export async function openNotebook(page, nb, name = 'test.ipynb') {
  const text = typeof nb === 'string' ? nb : JSON.stringify(nb)
  await page.setInputFiles('input[type=file]', { name, mimeType: 'application/json', buffer: Buffer.from(text) })
  await page.waitForFunction((n) => document.title.startsWith(n), name)
}

export function cell(page, index) {
  return page.locator('.cell').nth(index)
}

/** Wait until no cell is running or waiting. */
export async function waitIdle(page, timeout = 60_000) {
  await page.waitForFunction(() => !document.querySelector('.cell.is-running, .cell.is-queued'), null, { timeout })
}

export async function runCell(page, index, timeout = 60_000) {
  await cell(page, index).locator('.run-button').click()
  await waitIdle(page, timeout)
}

export async function runAll(page, timeout = 120_000) {
  await page.getByRole('button', { name: 'Run all' }).click()
  await waitIdle(page, timeout)
}

/** The visible text of a cell's outputs. */
export async function outputText(page, index) {
  return cell(page, index).locator('.cell-outputs').innerText()
}

export async function hasError(page, index) {
  return (await cell(page, index).locator('.output-error').count()) > 0
}

/** Run every cell and fail with the traceback if any cell raised. Returns the output text per cell. */
export async function runAllExpectingNoErrors(page, timeout = 120_000) {
  await runAll(page, timeout)
  const count = await page.locator('.cell').count()
  const texts = []
  for (let i = 0; i < count; i++) {
    const text = await outputText(page, i).catch(() => '')
    if (await hasError(page, i)) throw new Error(`Cell ${i} raised:\n${text}`)
    texts.push(text)
  }
  return texts
}

/** The notebook as the Download button would save it. */
export async function download(page) {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()])
  const stream = await file.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return { name: file.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') }
}

export async function waitSaved(page) {
  await page.waitForFunction(() => document.querySelector('.save-state')?.dataset.save === 'saved')
}
