/**
 * The real Worker for the end-to-end tests: `wrangler dev` (workerd) with the test bundle as its
 * assets and a local D1 database, set up by applying migrations/ with wrangler itself. Nothing
 * here talks to a Cloudflare account; the database is a file in a temporary folder.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** JSON with comments (wrangler.jsonc) to an object. */
export function parseJsonc(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      out += char
      if (char === '\\') out += text[++i]
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
    } else {
      out += char
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

/**
 * Start `wrangler dev` for the project's own wrangler.jsonc, changed only where a test must differ:
 * the assets folder (the offline test bundle), no build step, and test values for the data
 * controller. `database: false` removes the D1 binding, which is what a pull-request preview gets.
 */
export async function startWorker({ repo, assets, database = true, vars = {}, log = false }) {
  const wrangler = join(repo, 'node_modules', '.bin', 'wrangler')
  const folder = join(repo, '.wrangler', `e2e-${process.pid}-${database ? 'db' : 'nodb'}`)
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  const config = parseJsonc(readFileSync(join(repo, 'wrangler.jsonc'), 'utf8'))
  delete config.build
  delete config.$schema
  config.main = resolve(repo, config.main)
  config.assets.directory = resolve(assets)
  config.vars = { ...config.vars, ...vars }
  if (database) config.d1_databases[0].migrations_dir = resolve(repo, config.d1_databases[0].migrations_dir)
  else delete config.d1_databases
  const configFile = join(folder, 'wrangler.json')
  writeFileSync(configFile, JSON.stringify(config, null, 2))
  const state = join(folder, 'state')
  const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0' }

  let migration = ''
  if (database) {
    const applied = await run(wrangler, ['d1', 'migrations', 'apply', config.d1_databases[0].database_name, '--local', '--config', configFile, '--persist-to', state], { env, cwd: repo })
    migration = applied.stdout
    if (!/0001_init\.sql/.test(migration)) throw new Error(`wrangler did not apply the migration:\n${migration}\n${applied.stderr}`)
  }

  const port = await freePort()
  const inspector = await freePort()
  const child = spawn(wrangler, ['dev', '--config', configFile, '--persist-to', state, '--port', String(port), '--inspector-port', String(inspector), '--ip', '127.0.0.1', '--show-interactive-dev-session=false'], {
    env,
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let output = ''
  const ready = new Promise((done, fail) => {
    const onData = (chunk) => {
      output += chunk
      if (log) process.stderr.write(chunk)
      if (/Ready on http/.test(output)) done()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => fail(new Error(`wrangler dev stopped (exit ${code}):\n${output.slice(-2000)}`)))
    setTimeout(() => fail(new Error(`wrangler dev did not start within 60 s:\n${output.slice(-2000)}`)), 60_000).unref()
  })
  const exited = new Promise((done) => child.on('exit', done))
  const signal = (name) => {
    try {
      // wrangler and the workerd processes it started are one process group.
      process.kill(-child.pid, name)
    } catch {
      // Already gone.
    }
  }
  const close = async () => {
    signal('SIGTERM')
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))])
    signal('SIGKILL')
    await new Promise((done) => setTimeout(done, 200))
    rmSync(folder, { recursive: true, force: true })
  }
  try {
    await ready
  } catch (err) {
    await close()
    throw err
  }
  return {
    url: `http://127.0.0.1:${port}`,
    migration,
    configFile,
    state,
    output: () => output,
    close,
    /** Run the project's reset-link script against this local database; returns the link it prints. */
    async resetLink(email) {
      const result = await run(process.execPath, [join(repo, 'scripts', 'reset-link.ts'), email, '--local', `--base=http://127.0.0.1:${port}`, '--config', configFile, '--persist-to', state], { env, cwd: repo })
      const link = /http:\/\/127\.0\.0\.1:\d+\/reset#token=[\w-]+/.exec(result.stdout)
      if (!link) throw new Error(`reset-link printed no link:\n${result.stdout}\n${result.stderr}`)
      return link[0]
    },
  }
}
