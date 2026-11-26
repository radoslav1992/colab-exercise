/**
 * Node.js runtime for local development and for the tests: the API over SQLite and, if a build
 * folder is given, the site served the way Cloudflare serves it. Production runs on Cloudflare
 * (worker/index.ts) with D1 instead.
 */
import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { serve, type ServerType } from '@hono/node-server'
import type { Context } from 'hono'
import { createApi, type ApiOptions, type OutgoingEmail } from './app.ts'
import { asSqlDb, openDb } from './db.ts'
import { createStatic, type StaticOptions } from './static.ts'
import { sweepExpired } from './sweep.ts'

export interface ServerConfig {
  port: number
  /** A file, or ":memory:". */
  databasePath: string
  /** The built site, or null to serve only the API (Vite serves the site in development). */
  site: StaticOptions | null
  secureCookies?: boolean
  appUrl?: string
  controllerName?: string
  controllerContact?: string
  /** What to do with emails. Without it, "forgot password" is off, as on Cloudflare without the EMAIL binding. */
  sendEmail?: (message: OutgoingEmail) => Promise<void>
  now?: () => number
  /** Listen on this address only (default: 127.0.0.1). */
  hostname?: string
}

export interface RunningServer {
  url: string
  db: DatabaseSync
  close(): Promise<void>
}

/** One handler for a whole site: /api/* goes to the API, everything else to the build folder. */
export function createHandler(config: Omit<ServerConfig, 'port' | 'databasePath'>, db: DatabaseSync, apiOptions: Partial<ApiOptions> = {}) {
  const api = createApi({
    db: asSqlDb(db),
    secureCookies: config.secureCookies ?? false,
    clientIp: (c: Context) => (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket?.remoteAddress ?? 'local',
    appUrl: config.appUrl,
    controllerName: config.controllerName,
    controllerContact: config.controllerContact,
    sendEmail: config.sendEmail,
    now: config.now,
    ...apiOptions,
  })
  const files = config.site ? createStatic(config.site) : null
  return async (request: Request, env?: unknown): Promise<Response> => {
    const { pathname } = new URL(request.url)
    if (pathname === '/api' || pathname.startsWith('/api/')) return api.fetch(request, env as never)
    if (!files) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })
    const answer = files(pathname)
    return new Response(request.method === 'HEAD' ? null : (answer.body as BodyInit | null), { status: answer.status, headers: answer.headers })
  }
}

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const db = openDb(config.databasePath)
  const handler = createHandler(config, db)
  let server!: ServerType
  const port = await new Promise<number>((done) => {
    server = serve({ fetch: handler, port: config.port, hostname: config.hostname ?? '127.0.0.1' }, (info) => done(info.port))
  })
  // As the Cron Trigger does on Cloudflare: clear what has expired, now and then once a day.
  const sweep = () => void sweepExpired(asSqlDb(db)).catch((err: unknown) => console.error('Sweep failed', err))
  sweep()
  const sweeper = setInterval(sweep, 24 * 60 * 60 * 1000)
  sweeper.unref()
  return {
    url: `http://${config.hostname ?? '127.0.0.1'}:${port}`,
    db,
    close: () =>
      new Promise<void>((done) => {
        clearInterval(sweeper)
        server.close(() => {
          db.close()
          done()
        })
        // Open keep-alive connections would keep close() waiting.
        ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
      }),
  }
}
