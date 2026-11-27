/**
 * The pieces around the app: addresses of the views, the landing page and the doodles, the static
 * server that stands in for Cloudflare's assets, the Worker without a database, the Cloudflare
 * configuration and the privacy text.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStatic } from '../../server/static.ts'
import { CONTROLLER_PLACEHOLDER, privacySections, RESET_MINUTES, SESSION_DAYS } from '../../src/legal.ts'
import { hrefFor, PAGES, parseRoute, type Route } from '../../src/router.ts'
import { samples } from '../../src/samples.ts'
import { RESET_MINUTES as SERVER_RESET_MINUTES, SESSION_DAYS as SERVER_SESSION_DAYS } from '../../server/app.ts'
import worker from '../../worker/index.ts'
import { parseJsonc } from '../e2e/worker.mjs'

const ID = 'abcdefghij0123456789'
const OTHER = 'zyxwvutsrq9876543210'

describe('addresses of the views', () => {
  const routes: Route[] = [
    { view: 'playground' },
    { view: 'playground', sample: '03-llm-tokens-and-sampling' },
    { view: 'courses' },
    { view: 'course', id: ID },
    { view: 'assignment', id: ID },
    { view: 'starter', id: ID },
    { view: 'submission', assignment: ID, student: OTHER },
    { view: 'account' },
    { view: 'privacy' },
    { view: 'reset' },
  ]

  it('round-trip between a view and its address', () => {
    for (const route of routes) {
      const url = new URL(hrefFor(route), 'https://lab.test')
      expect(parseRoute(url), hrefFor(route)).toEqual(route)
    }
    expect(parseRoute({ pathname: '/courses/', search: '' })).toEqual({ view: 'courses' })
    // Where the landing page sends somebody to sign in: the request is not part of the view.
    expect(parseRoute({ pathname: '/courses', search: '?auth=signup&role=teacher' })).toEqual({ view: 'courses' })
  })

  it('has no view for the start page: "/" is the landing page, a document of its own', () => {
    expect(parseRoute({ pathname: '/', search: '' })).toEqual({ view: 'not-found' })
    expect(PAGES).not.toContain('index')
    expect(PAGES).not.toContain('app')
  })

  it('takes the name of a sample from the address only if it looks like one', () => {
    for (const sample of samples) {
      const name = sample.file.replace(/\.ipynb$/, '')
      expect(parseRoute({ pathname: '/playground', search: `?sample=${name}` })).toEqual({ view: 'playground', sample: name })
    }
    for (const search of ['?sample=', '?sample=../01-speech-to-text', '?sample=01-speech-to-text.ipynb', '?sample=%3Cscript%3E', '?sample=A', `?sample=${'a'.repeat(80)}`, '?other=1']) {
      expect(parseRoute({ pathname: '/playground', search }), search).toEqual({ view: 'playground' })
    }
  })

  it('has a page file for every address, so that reload works and anything else is a real 404', () => {
    const paths = new Set(routes.map((route) => new URL(hrefFor(route), 'https://lab.test').pathname.slice(1)))
    expect([...paths].sort()).toEqual([...PAGES].sort())
  })

  it('never takes an id that is not an id from the address', () => {
    for (const search of ['', '?id=', '?id=../../api/courses', '?id=ABCDEFGHIJ0123456789', `?id=${ID}x`, '?id=%3Cscript%3E']) {
      expect(parseRoute({ pathname: '/course', search }), search).toEqual({ view: 'not-found' })
      expect(parseRoute({ pathname: '/assignment', search })).toEqual({ view: 'not-found' })
    }
    expect(parseRoute({ pathname: '/submission', search: `?id=${ID}` })).toEqual({ view: 'not-found' })
    expect(parseRoute({ pathname: '/submission', search: `?id=${ID}&student=nope` })).toEqual({ view: 'not-found' })
    expect(parseRoute({ pathname: '/admin', search: '' })).toEqual({ view: 'not-found' })
  })
})

describe('the landing page and the other documents', () => {
  const landing = readFileSync('index.html', 'utf8')
  const app = readFileSync('app.html', 'utf8')
  const missing = readFileSync('404.html', 'utf8')

  it('links every topic to a sample notebook that exists, and all six are there', () => {
    const linked = [...landing.matchAll(/href="\/playground\?sample=([^"]+)"/g)].map((match) => `${match[1]}.ipynb`)
    expect(linked.sort()).toEqual(samples.map((sample) => sample.file).sort())
  })

  it('may be indexed and describes itself; the app and the 404 page stay out of search engines', () => {
    expect(landing).not.toContain('noindex')
    expect(landing).toMatch(/<title>[^<]{20,70}<\/title>/)
    for (const name of ['name="description"', 'property="og:title"', 'property="og:description"']) expect(landing).toContain(name)
    expect(landing.match(/<h1[\s>]/g)).toHaveLength(1)
    // The domain of the site is not known: nothing absolute.
    expect(landing).not.toMatch(/(?:href|src|content)="https?:/)
    expect(landing).not.toContain('rel="canonical"')
    expect(app).toContain('<meta name="robots" content="noindex" />')
    expect(missing).toContain('<meta name="robots" content="noindex" />')
  })

  it('has no inline script and no inline event handler, as the Content-Security-Policy demands', () => {
    for (const html of [landing, app, missing]) {
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
      expect(html).not.toMatch(/\son[a-z]+=/)
    }
  })

  it('shows no account control until the script knows that there are accounts', () => {
    const controls = [...landing.matchAll(/<(a|p)\b[^>]*data-account="(in|out)"[^>]*>/g)]
    expect(controls.length).toBeGreaterThanOrEqual(6)
    for (const [tag] of controls) expect(tag, tag).toMatch(/\shidden>$/)
    // Every link that signs somebody in or up is one of those controls, or inside one.
    const links = [...landing.matchAll(/<a\b[^>]*href="\/courses[^"]*"[^>]*>/g)].map(([tag]) => tag)
    const outside = links.filter((tag) => !tag.includes('data-account='))
    expect(outside).toEqual(['<a class="button primary" href="/courses?auth=signup&amp;role=teacher">'])
    expect(landing).toMatch(/<p class="calls" data-account="out" hidden>\s*<a class="button primary" href="\/courses\?auth=signup&amp;role=teacher">/)
  })

  it('applies a chosen theme before the first paint, with the key the app saves it under', () => {
    const script = readFileSync('public/theme.js', 'utf8')
    expect(script).toContain("localStorage.getItem('notebook-lab:theme')")
    expect(readFileSync('src/storage.ts', 'utf8')).toContain('const THEME = `${PREFIX}theme`')
    for (const html of [landing, app, missing]) expect(html).toContain('<script src="/theme.js"></script>')
  })

  it('only asks for doodles that exist', () => {
    const drawn = readdirSync('src/doodles').map((file) => file.replace('.svg', ''))
    for (const html of [landing, missing]) {
      const asked = [...html.matchAll(/<!-- doodle:([a-z0-9-]+)/g)].map((match) => match[1])
      expect(asked.length).toBeGreaterThan(0)
      for (const name of asked) expect(drawn, name).toContain(name)
    }
  })
})

describe('the doodles', () => {
  const files = readdirSync('src/doodles').filter((file) => file.endsWith('.svg'))

  it('are drawn by scripts/doodles.mjs, and drawing them again gives the same files', () => {
    const out = mkdtempSync(join(tmpdir(), 'notebook-lab-doodles-'))
    execFileSync(process.execPath, ['scripts/doodles.mjs'], { env: { ...process.env, DOODLES_OUT: out }, stdio: 'pipe' })
    expect(readdirSync(out).filter((file) => file !== 'favicon.svg').sort()).toEqual([...files].sort())
    for (const file of files) expect(readFileSync(join(out, file), 'utf8'), file).toBe(readFileSync(join('src/doodles', file), 'utf8'))
    expect(readFileSync(join(out, 'favicon.svg'), 'utf8')).toBe(readFileSync('public/favicon.svg', 'utf8'))
  })

  it('are decoration in ink: hidden from screen readers, no colour of their own, no script, light', () => {
    let total = 0
    for (const file of files) {
      const svg = readFileSync(join('src/doodles', file), 'utf8')
      total += svg.length
      expect(svg, file).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" class="doodle doodle-[a-z0-9-]+" viewBox="0 0 \d+ \d+"/)
      expect(svg, file).toContain('stroke="currentColor"')
      expect(svg, file).toContain('aria-hidden="true"')
      // Colours come from the theme (classes in src/base.css), so that the doodles work on dark paper.
      expect(svg, file).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|style=|<script|href=/i)
      // One decimal place at most.
      expect(svg, file).not.toMatch(/\d\.\d{2,}/)
      expect(svg.length, file).toBeLessThan(6_000)
    }
    expect(total).toBeLessThan(45_000)
  })
})

describe('the static server that stands in for Cloudflare assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-lab-static-'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'index.html'), 'index')
  writeFileSync(join(root, 'course.html'), 'course')
  writeFileSync(join(root, '404.html'), 'missing')
  writeFileSync(join(root, 'assets', 'app.js'), 'js')
  writeFileSync(join(root, '_headers'), '/*\n  X-Test: all\n/assets/*\n  Cache-Control: immutable\n')
  writeFileSync(join(tmpdir(), 'notebook-lab-outside.txt'), 'outside')
  const files = createStatic({ root, headersFile: join(root, '_headers') })
  const text = (answer: { body: Uint8Array | null }) => new TextDecoder().decode(answer.body ?? new Uint8Array())

  it('serves pages without their .html, and moves the .html address to the short one', () => {
    expect([files('/').status, text(files('/'))]).toEqual([200, 'index'])
    expect([files('/course').status, text(files('/course'))]).toEqual([200, 'course'])
    expect(files('/course').headers['Content-Type']).toBe('text/html; charset=utf-8')
    expect([files('/course.html').status, files('/course.html').headers.Location]).toEqual([307, '/course'])
    expect([files('/index.html').status, files('/index.html').headers.Location]).toEqual([307, '/'])
    expect([files('/course/').status, files('/course/').headers.Location]).toEqual([307, '/course'])
  })

  it('answers everything else with 404.html and status 404, and never leaves the folder', () => {
    for (const path of ['/nope', '/courses', '/assets/', '/../notebook-lab-outside.txt', '/%2e%2e/notebook-lab-outside.txt', '/assets/../../notebook-lab-outside.txt', '/%00', '/%zz']) {
      const answer = files(path)
      expect([path, answer.status, text(answer)]).toEqual([path, 404, 'missing'])
    }
  })

  it('applies the rules of _headers', () => {
    expect(files('/').headers['X-Test']).toBe('all')
    expect(files('/nope').headers['X-Test']).toBe('all')
    expect(files('/assets/app.js').headers).toMatchObject({ 'X-Test': 'all', 'Cache-Control': 'immutable', 'Content-Type': 'text/javascript; charset=utf-8' })
    expect(files('/').headers['Cache-Control']).toBeUndefined()
  })
})

describe('the Worker', () => {
  const assets = { fetch: async () => new Response('asset') }
  const context = { waitUntil() {} }
  const call = (path: string, init?: RequestInit, env: Record<string, unknown> = {}) => worker.fetch(new Request(`https://lab.test${path}`, init), { ASSETS: assets, ...env }, context)

  it('without a database answers 503 as JSON, except to the question what the deployment offers', async () => {
    const config = await call('/api/config', undefined, { CONTROLLER_NAME: ' Example University ', CONTROLLER_CONTACT: '' })
    expect(config.status).toBe(200)
    expect(await config.json()).toEqual({ accounts: false, passwordReset: false, controller: { name: 'Example University', contact: '' } })
    for (const [path, init] of [
      ['/api/auth/session', undefined],
      ['/api/courses', undefined],
      ['/api', undefined],
      ['/api/config', { method: 'POST' }],
      ['/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await call(path, init)
      expect(res.status, path).toBe(503)
      expect(res.headers.get('content-type')).toMatch(/^application\/json/)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toEqual({ error: 'Accounts are not set up on this deployment.' })
    }
  })

  it('hands everything that is not the API to the assets', async () => {
    expect(await (await call('/')).text()).toBe('asset')
    expect(await (await call('/apiary')).text()).toBe('asset')
  })

  it('sweeps on the daily schedule only when there is a database', async () => {
    await worker.scheduled({}, { ASSETS: assets }, context)
    const statements: string[] = []
    const waiting: Array<Promise<unknown>> = []
    const db = {
      prepare(sql: string) {
        statements.push(sql)
        const statement = { bind: () => statement, first: async () => null, all: async () => ({ results: [] }), run: async () => null }
        return statement
      },
      batch: async () => null,
    }
    await worker.scheduled({}, { ASSETS: assets, DB: db }, { waitUntil: (p: Promise<unknown>) => void waiting.push(p) })
    await Promise.all(waiting)
    expect(statements.map((sql) => /DELETE FROM (\w+)/.exec(sql)?.[1])).toEqual(['sessions', 'password_resets', 'rate_limits'])
  })
})

describe('wrangler.jsonc', () => {
  const config = parseJsonc(readFileSync('wrangler.jsonc', 'utf8')) as Record<string, any>

  it('runs the Worker for the API only and serves pages as files, with a real 404', () => {
    expect(config.main).toBe('worker/index.ts')
    expect(config.assets).toEqual({ directory: './dist', binding: 'ASSETS', not_found_handling: '404-page', run_worker_first: ['/api/*'] })
  })

  it('binds the database with its migrations, and a daily cron', () => {
    expect(config.d1_databases).toEqual([{ binding: 'DB', database_name: 'colab-exercise', database_id: '0bafc51f-2518-475e-ab08-c38c90cbfb94', migrations_dir: 'migrations' }])
    expect(config.triggers.crons).toHaveLength(1)
    expect(config.triggers.crons[0]).toMatch(/^\d+ \d+ \* \* \*$/)
  })

  it('leaves email off and the data controller as empty placeholders, never invented', () => {
    expect(config.send_email).toBeUndefined()
    expect(readFileSync('wrangler.jsonc', 'utf8')).toContain('// "send_email"')
    expect(config.vars).toEqual({ CONTROLLER_NAME: '', CONTROLLER_CONTACT: '' })
    // Previews get no bindings: no database, so no accounts.
    expect(Object.keys(config.previews)).toEqual(['observability'])
  })
})

describe('the privacy text', () => {
  const flat = (controller: { name: string; contact: string }, accounts: boolean) =>
    privacySections(controller, accounts)
      .flatMap((s) => [s.heading, ...s.blocks.flat()])
      .join('\n')

  it('marks the data controller as not set until the owner configures it', () => {
    const empty = flat({ name: '', contact: '' }, true)
    expect(empty.split(CONTROLLER_PLACEHOLDER).length - 1).toBe(3)
    const set = flat({ name: 'Example University', contact: 'privacy@example.edu' }, true)
    expect(set).not.toContain('NOT SET')
    expect(set).toContain('The data controller for this site is: Example University.')
    expect(set).toContain('privacy@example.edu')
  })

  it('says what is stored, where, how long, how to delete it, and where code and models come from', () => {
    const text = flat({ name: 'X', contact: 'x@example.edu' }, true)
    for (const phrase of ['name, email address', 'Course membership', 'Your notebooks', 'Your submissions', 'Grades and feedback', 'Cloudflare', 'Delete your account', 'Leave a course', 'jsDelivr', 'Hugging Face', 'runs in your own browser', 'no analytics', 'one cookie']) {
      expect(text, phrase).toContain(phrase)
    }
    expect(text).toContain(`${SESSION_DAYS} days`)
    expect(text).toContain(`${RESET_MINUTES} minutes`)
    expect([SESSION_DAYS, RESET_MINUTES]).toEqual([SERVER_SESSION_DAYS, SERVER_RESET_MINUTES])
  })

  it('does not talk about accounts on a deployment that has none', () => {
    const text = flat({ name: '', contact: '' }, false)
    expect(text).toContain('This deployment has no accounts')
    expect(text).not.toContain('What is stored when you have an account')
    expect(text).toContain('jsDelivr')
  })
})
