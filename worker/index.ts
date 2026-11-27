/**
 * Cloudflare Workers entry. Static files are served straight from the assets (wrangler.jsonc sends
 * only /api/* here); /api/* runs the same API as the Node server, backed by D1.
 */
import { createApi, type Api, type OutgoingEmail, type PublicConfig } from '../server/app.ts'
import type { SqlDb } from '../server/sql.ts'
import { sweepExpired } from '../server/sweep.ts'

/** The parts of Cloudflare's bindings that are used here. */
interface AssetsBinding {
  fetch(request: Request): Promise<Response>
}

interface EmailBinding {
  send(message: { from: { name: string; email: string }; to: string; replyTo?: string; subject: string; text: string; html: string }): Promise<unknown>
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

export interface Env {
  /** The D1 database. Absent on pull-request previews: the site is then the playground only. */
  DB?: SqlDb
  ASSETS: AssetsBinding
  /** Cloudflare Email Service (send_email in wrangler.jsonc). Without it, "forgot password" does not send email. */
  EMAIL?: EmailBinding
  /** The site's address for links in emails, for example https://notebooks.example.edu. */
  APP_URL?: string
  /** The address emails come from; it must be on a domain set up for Email Sending. */
  MAIL_FROM?: string
  /** Who is responsible for the data (privacy page). Empty until the owner fills them in. */
  CONTROLLER_NAME?: string
  CONTROLLER_CONTACT?: string
}

const JSON_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

function mailer(env: Env): ((message: OutgoingEmail) => Promise<void>) | undefined {
  const binding = env.EMAIL
  const from = env.MAIL_FROM
  if (!binding || !from) return undefined
  return async (m) => {
    await binding.send({ from: { name: 'Notebook Lab', email: from }, to: m.to, ...(m.replyTo && { replyTo: m.replyTo }), subject: m.subject, text: m.text, html: m.html })
  }
}

const apis = new Map<boolean, { db: SqlDb; api: Api }>()

/** The API for this database. `secure` is false only under `wrangler dev`, which serves plain http on localhost. */
function apiFor(env: Env, db: SqlDb, secure: boolean): Api {
  let entry = apis.get(secure)
  if (entry?.db !== db) {
    entry = {
      db,
      api: createApi({
        db,
        secureCookies: secure,
        sendEmail: mailer(env),
        appUrl: env.APP_URL,
        controllerName: env.CONTROLLER_NAME,
        controllerContact: env.CONTROLLER_CONTACT,
      }),
    }
    apis.set(secure, entry)
  }
  return entry.api
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (!env.DB) {
        // No database (a preview): the page asks /api/config once and shows the playground only.
        // Everything else answers 503.
        if (pathname === '/api/config' && request.method === 'GET') {
          const config: PublicConfig = {
            accounts: false,
            passwordReset: false,
            controller: { name: env.CONTROLLER_NAME?.trim() ?? '', contact: env.CONTROLLER_CONTACT?.trim() ?? '' },
          }
          return Response.json(config, { headers: JSON_HEADERS })
        }
        return Response.json({ error: 'Accounts are not set up on this deployment.' }, { status: 503, headers: JSON_HEADERS })
      }
      // The session cookie is marked Secure everywhere except under `wrangler dev` (http on localhost).
      const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
      const api = apiFor(env, env.DB, !local)
      return api.fetch(request, env, ctx as never)
    }
    return env.ASSETS.fetch(request)
  },

  // Once a day (triggers.crons in wrangler.jsonc): delete expired sessions, reset links and rate-limit rows.
  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContextLike): Promise<void> {
    if (env.DB) ctx.waitUntil(sweepExpired(env.DB))
  },
}
