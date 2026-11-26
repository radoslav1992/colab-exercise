/**
 * Serving a build folder the way Cloudflare's static assets do, for local runs and for the tests:
 * the rules of public/_headers, "/course" answered by course.html, and 404.html with status 404
 * for every address that is not a file. Nothing here runs on Cloudflare.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ipynb': 'application/json',
  '.wav': 'audio/wav',
}

export interface HeaderRule {
  pattern: RegExp
  headers: Array<[string, string]>
}

/** Parse a Cloudflare `_headers` file. */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = []
  let current: HeaderRule | null = null
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    if (!/^\s/.test(raw)) {
      const pattern = new RegExp('^' + raw.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      current = { pattern, headers: [] }
      rules.push(current)
    } else if (current) {
      const i = raw.indexOf(':')
      current.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()])
    }
  }
  return rules
}

export interface StaticOptions {
  /** The build folder (dist). */
  root: string
  /** A `_headers` file whose rules are applied to every answer. */
  headersFile?: string
  /** Extra addresses that are answered from files outside the build folder (tests). */
  extraFiles?: Record<string, string>
}

export interface StaticAnswer {
  status: number
  headers: Record<string, string>
  body: Uint8Array | null
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Returns a function that answers a path of the site. */
export function createStatic(options: StaticOptions): (pathname: string) => StaticAnswer {
  const base = resolve(options.root)
  const rules = options.headersFile && existsSync(options.headersFile) ? parseHeaders(readFileSync(options.headersFile, 'utf8')) : []
  const extraFiles = options.extraFiles ?? {}

  const fileFor = (path: string): string | null => {
    const file = join(base, normalize(path))
    return (file === base || file.startsWith(base + sep)) && isFile(file) ? file : null
  }

  return (pathname) => {
    const headers: Record<string, string> = {}
    for (const rule of rules) if (rule.pattern.test(pathname)) for (const [name, value] of rule.headers) headers[name] = value
    let path: string
    try {
      path = decodeURIComponent(pathname)
    } catch {
      path = '/\u0000'
    }
    const answer = (file: string, status = 200): StaticAnswer => ({
      status,
      headers: { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', ...headers },
      body: readFileSync(file),
    })
    const redirect = (to: string): StaticAnswer => ({ status: 307, headers: { Location: to, ...headers }, body: null })

    if (extraFiles[path]) return answer(extraFiles[path])
    if (!path.includes('\u0000')) {
      // Cloudflare's default "auto-trailing-slash": /course is course.html, and /course.html moves to /course.
      if (path.endsWith('/index.html')) return redirect(path.slice(0, -'index.html'.length))
      if (path.endsWith('.html') && fileFor(path)) return redirect(path.slice(0, -'.html'.length))
      if (path.endsWith('/')) {
        const index = fileFor(`${path}index.html`)
        if (index) return answer(index)
        if (path.length > 1 && fileFor(`${path.slice(0, -1)}.html`)) return redirect(path.slice(0, -1))
      } else {
        const exact = fileFor(path)
        if (exact) return answer(exact)
        const page = fileFor(`${path}.html`)
        if (page) return answer(page)
      }
    }
    const notFound = fileFor('/404.html')
    if (notFound) return answer(notFound, 404)
    return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers }, body: new TextEncoder().encode('Not found') }
  }
}
