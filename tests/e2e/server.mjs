/**
 * A small static file server for the end-to-end tests. It serves a build folder and applies the
 * rules of public/_headers the way Cloudflare does, so the tests run under the real
 * Content-Security-Policy.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'

const TYPES = {
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

/** Parse a Cloudflare `_headers` file into [{ pattern: RegExp, headers: [[name, value]] }]. */
export function parseHeaders(text) {
  const rules = []
  let current = null
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

export async function startServer({ root, headersFile, port = 0, extraFiles = {} }) {
  const base = resolve(root)
  const rules = headersFile ? parseHeaders(await readFile(headersFile, 'utf8')) : []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    let path = decodeURIComponent(url.pathname)
    if (path.endsWith('/')) path += 'index.html'
    const headers = {}
    for (const rule of rules) if (rule.pattern.test(url.pathname)) for (const [name, value] of rule.headers) headers[name] = value
    try {
      const extra = extraFiles[path]
      const file = extra ?? join(base, normalize(path))
      if (!extra && !file.startsWith(base)) throw new Error('outside root')
      const body = await readFile(file)
      response.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', ...headers })
      response.end(body)
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain', ...headers })
      response.end('Not found')
    }
  })
  await new Promise((done) => server.listen(port, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) }
}
