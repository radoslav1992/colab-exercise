/**
 * The JSON API, mounted at /api. The same code runs on Cloudflare Workers (worker/index.ts, with
 * D1) and on Node.js (server/server.ts, with SQLite).
 *
 * The server stores data only. It never runs notebook code and never renders a notebook: stored
 * notebooks leave it as JSON inside JSON answers, and every answer is `application/json`.
 *
 * Who may do what is decided per course, never by the role chosen at sign-up: the owner of a
 * course is its teacher, people in `enrollments` are its students, everybody else gets 404.
 */
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
  isJoinCode,
  LIMITS,
  MAX_NOTEBOOK_BODY_BYTES,
  MAX_NOTEBOOK_BYTES,
  MAX_NOTEBOOK_CELLS,
  normalizeJoinCode,
  SESSION_HEADER,
  type AssignmentState,
  type Role,
  type StudentStatus,
} from '../shared/limits.ts'
import { burnPasswordCheck, equalText, hashPassword, hashToken, ID_PATTERN, newId, newJoinCode, newToken, verifyPassword } from './crypto.ts'
import { RateLimiter } from './rate-limit.ts'
import { ASSIGNMENT_COLUMNS, type AssignmentRow, type CourseRow, type SqlDb, type UserRow } from './sql.ts'

export const SESSION_COOKIE = 'notebook_lab_session'
export const SESSION_DAYS = 30
export const RESET_MINUTES = 60
const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const encoder = new TextEncoder()

/** The notebook a new assignment starts with until the teacher uploads or picks one. */
export const EMPTY_NOTEBOOK =
  '{"cells":[{"cell_type":"code","execution_count":null,"id":"cell-1","metadata":{},"outputs":[],"source":[]}],' +
  '"metadata":{"kernelspec":{"display_name":"Python 3","language":"python","name":"python3"},"language_info":{"name":"python"}},"nbformat":4,"nbformat_minor":5}'

export interface OutgoingEmail {
  to: string
  replyTo?: string
  subject: string
  text: string
  html: string
}

export interface ApiOptions {
  /** A Cloudflare D1 database, or the SQLite adapter from server/db.ts. */
  db: SqlDb
  /** Send the session cookie with the Secure flag (true in production, over HTTPS). */
  secureCookies: boolean
  /** How to find the caller's IP address for rate limits. */
  clientIp?: (c: Context) => string
  now?: () => number
  /** Sends an email (password reset links). Without it, "forgot password" answers 503. */
  sendEmail?: (message: OutgoingEmail) => Promise<void>
  /** The site's address for links in emails. Without it the request's own origin is used. */
  appUrl?: string
  /** Who is responsible for the data, for the privacy page and for "forgot password" without email. Never invented. */
  controllerName?: string
  controllerContact?: string
}

export interface PublicUser {
  id: string
  email: string
  name: string
  role: Role
  createdAt: number
}

/** What every deployment can answer, with or without a database: see worker/index.ts. */
export interface PublicConfig {
  accounts: boolean
  passwordReset: boolean
  controller: { name: string; contact: string }
}

type Env = { Variables: { user: UserRow | null; tokenHash: string | null } }
type Ctx = Context<Env>

function publicUser(u: UserRow): PublicUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at }
}

/**
 * The key rate limits use for an address. IPv6 users usually control a whole /64 block, so all of
 * its addresses share one key.
 */
export function ipKey(ip: string): string {
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (v4) return v4[1]
  if (!ip.includes(':')) return ip
  const [head, tail = ''] = ip.toLowerCase().split('::')
  const left = head ? head.split(':') : []
  const right = ip.includes('::') && tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64'
}

// --- Reading and checking what was sent -----------------------------------------------------------

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max ? v : null
}

/** One line of text: trimmed, without control characters. Null if it is not text or too long. */
function line(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()
  return clean.length <= max ? clean : null
}

/** Several lines of text (Markdown, feedback): line breaks and tabs stay, other control characters go. */
function prose(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, '').trim()
  return clean.length <= max ? clean : null
}

/** Points and grades: 0 to LIMITS.maxPoints with at most two decimals. `undefined` means "not a valid number". */
function points(v: unknown): number | null | undefined {
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > LIMITS.maxPoints) return undefined
  return Math.round(v * 100) / 100
}

const MIN_TIME = Date.UTC(2000, 0, 1)
const MAX_TIME = Date.UTC(2100, 0, 1)

function time(v: unknown): number | null | undefined {
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_TIME || v > MAX_TIME) return undefined
  return v
}

/** A file name to show and to offer for downloads: no folders, no control characters, ends in .ipynb. */
export function cleanFileName(v: unknown): string | null {
  const name = line(v, LIMITS.fileName)
  if (name === null) return null
  const base = name.replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').trim()
  if (!base) return null
  return base.toLowerCase().endsWith('.ipynb') ? base : `${base}.ipynb`.slice(0, LIMITS.fileName + 6)
}

/** The least a stored notebook must be: nbformat 4 with a list of cell objects. The page treats the rest as untrusted. */
function isNotebook(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const nb = value as { nbformat?: unknown; cells?: unknown }
  if (nb.nbformat !== 4 || !Array.isArray(nb.cells) || nb.cells.length > MAX_NOTEBOOK_CELLS) return false
  return nb.cells.every((cell) => typeof cell === 'object' && cell !== null && !Array.isArray(cell))
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The password reset email, as plain text and simple HTML. */
export function resetEmail(user: Pick<UserRow, 'email' | 'name'>, link: string, site: string, contact?: string): OutgoingEmail {
  const name = user.name || user.email.split('@')[0]
  const text = [
    `Hello ${name},`,
    '',
    'Someone, hopefully you, asked to reset the password of your Notebook Lab account. Open this link to choose a new one:',
    '',
    link,
    '',
    `The link works once and expires in ${RESET_MINUTES} minutes. If you did not ask for this, ignore this email: your password stays the same.`,
    ...(contact ? ['', `Questions? Write to ${contact}.`] : []),
    '',
    'Notebook Lab',
    site,
  ].join('\n')
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1b1d21">
<p style="margin:0 0 12px;font-weight:700">Notebook Lab</p>
<p style="margin:0 0 12px">Hello ${escapeHtml(name)},</p>
<p style="margin:0 0 16px;line-height:1.5">Someone, hopefully you, asked to reset the password of your Notebook Lab account.</p>
<p style="margin:0 0 16px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#2553c7;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:6px">Choose a new password</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:1.5">The link works once and expires in ${RESET_MINUTES} minutes. If you did not ask for this, ignore this email: your password stays the same.</p>
<p style="margin:12px 0 0;font-size:12px;word-break:break-all">If the button does not work, copy this address into your browser:<br>${escapeHtml(link)}</p>
${contact ? `<p style="margin:12px 0 0;font-size:12px">Questions? Write to ${escapeHtml(contact)}.</p>` : ''}
</body></html>`
  return { to: user.email, ...(contact && contact.includes('@') && { replyTo: contact }), subject: 'Reset your Notebook Lab password', text, html }
}

// --- Rows as the API shows them ---------------------------------------------------------------------

interface AccessRow extends CourseRow {
  /** When the caller joined as a student; null for everybody else. */
  joined_at: number | null
}

interface AssignmentAccessRow extends AssignmentRow {
  owner_id: string
  course_name: string
  archived_at: number | null
  joined_at: number | null
}

interface StudentWorkRow {
  work_updated_at: number | null
  started_at: number | null
  submitted_at: number | null
  late: number | null
  count: number | null
  checks_passed: number | null
  checks_total: number | null
  grade: number | null
  feedback: string | null
  graded_at: number | null
}

function statusOf(row: StudentWorkRow): StudentStatus {
  if (row.submitted_at !== null) return row.late ? 'late' : 'submitted'
  return row.started_at !== null || row.work_updated_at !== null ? 'in-progress' : 'not-started'
}

function publicAssignment(a: AssignmentRow) {
  return {
    id: a.id,
    courseId: a.course_id,
    title: a.title,
    instructions: a.instructions,
    dueAt: a.due_at,
    points: a.points,
    state: a.state,
    gradesReleased: a.grades_released_at !== null,
  }
}

/** The JSON API. */
export function createApi(opts: ApiOptions) {
  const { db } = opts
  const now = opts.now ?? Date.now
  const limiter = new RateLimiter(db, now)
  const rawIp = opts.clientIp ?? ((c: Context) => c.req.header('cf-connecting-ip') ?? 'unknown')
  const clientIp = (c: Context) => ipKey(rawIp(c))
  const config: PublicConfig = {
    accounts: true,
    passwordReset: Boolean(opts.sendEmail),
    controller: { name: opts.controllerName?.trim() ?? '', contact: opts.controllerContact?.trim() ?? '' },
  }

  const sql = {
    userByEmail: (email: string) => db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>(),
    userById: (id: string) => db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>(),
    session: (tokenHash: string) =>
      db
        .prepare('SELECT user_id, secret_hash, expires_at FROM sessions WHERE token_hash = ?')
        .bind(tokenHash)
        .first<{ user_id: string; secret_hash: string; expires_at: number }>(),
    deleteSession: (tokenHash: string) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run(),
    /** A course, and whether the caller is enrolled in it. */
    course: (id: string, userId: string) =>
      db
        .prepare('SELECT c.*, (SELECT e.joined_at FROM enrollments e WHERE e.course_id = c.id AND e.user_id = ?) AS joined_at FROM courses c WHERE c.id = ?')
        .bind(userId, id)
        .first<AccessRow>(),
    /** An assignment without its starter, with its course's owner and whether the caller is enrolled. */
    assignment: (id: string, userId: string) =>
      db
        .prepare(
          `SELECT ${ASSIGNMENT_COLUMNS.split(', ').map((col) => `a.${col}`).join(', ')}, c.owner_id, c.name AS course_name, c.archived_at,
             (SELECT e.joined_at FROM enrollments e WHERE e.course_id = a.course_id AND e.user_id = ?) AS joined_at
           FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ?`,
        )
        .bind(userId, id)
        .first<AssignmentAccessRow>(),
    count: async (query: string, ...values: unknown[]) => (await db.prepare(query).bind(...values).first<{ n: number }>())?.n ?? 0,
  }

  const cookieOptions = { httpOnly: true, secure: opts.secureCookies, sameSite: 'Strict', path: '/api', maxAge: SESSION_DAYS * 86_400 } as const

  /**
   * Start a session: the token goes into the HttpOnly cookie, the secret into the answer (once).
   * The page keeps the secret in localStorage and sends it in a header; see the README.
   */
  const startSession = async (c: Ctx, userId: string): Promise<string> => {
    const token = newToken()
    const secret = newToken()
    const t = now()
    await db
      .prepare('INSERT INTO sessions (token_hash, secret_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await hashToken(token), await hashToken(secret), userId, t, t + SESSION_DAYS * DAY_MS)
      .run()
    setCookie(c, SESSION_COOKIE, token, cookieOptions)
    return secret
  }

  const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503, error: string, extra: Record<string, unknown> = {}) =>
    c.json({ error, ...extra }, status)
  const signIn = (c: Context) => fail(c, 401, 'Please sign in.')
  const notFound = (c: Context, what = 'That') => fail(c, 404, `${what} was not found, or you do not have access to it.`)
  const tooMany = (c: Context) => fail(c, 429, 'Too many requests. Please wait a few minutes and try again.')
  const smallBody = bodyLimit({ maxSize: 128 * 1024, onError: (c) => fail(c, 413, 'That request is too large.') })
  const notebookBody = bodyLimit({
    maxSize: MAX_NOTEBOOK_BODY_BYTES,
    onError: (c) => fail(c, 413, `A notebook can be at most ${MAX_NOTEBOOK_BYTES / 1_000_000} MB on the server.`, { tooLarge: true }),
  })

  /** An answer whose `notebook` field is the stored JSON text, put in as it is (it was checked when it was stored). */
  const withNotebook = (c: Context, fields: Record<string, unknown>, notebook: string, status: 200 | 201 = 200) => {
    const head = JSON.stringify(fields)
    return c.body(`${head.slice(0, -1)}${head.length > 2 ? ',' : ''}"notebook":${notebook}}`, status, { 'Content-Type': 'application/json' })
  }

  /** The notebook in the request body: its text if it is valid and small enough, else the error answer. */
  const readNotebook = async (c: Context): Promise<{ text: string } | { response: Response }> => {
    const text = await c.req.text()
    if (encoder.encode(text).length > MAX_NOTEBOOK_BYTES) {
      return { response: fail(c, 413, `A notebook can be at most ${MAX_NOTEBOOK_BYTES / 1_000_000} MB on the server.`, { tooLarge: true }) }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    if (!isNotebook(parsed)) return { response: fail(c, 400, 'That is not a Jupyter notebook (nbformat 4).') }
    return { text }
  }

  /** The course if the caller teaches it or is enrolled in it. */
  const courseFor = async (user: UserRow, id: string): Promise<{ course: AccessRow; teacher: boolean } | null> => {
    if (!ID_PATTERN.test(id)) return null
    const course = await sql.course(id, user.id)
    if (!course) return null
    if (course.owner_id === user.id) return { course, teacher: true }
    return course.joined_at !== null ? { course, teacher: false } : null
  }

  /** The assignment if the caller teaches its course, or is enrolled and the assignment is not a draft. */
  const assignmentFor = async (user: UserRow, id: string): Promise<{ assignment: AssignmentAccessRow; teacher: boolean } | null> => {
    if (!ID_PATTERN.test(id)) return null
    const assignment = await sql.assignment(id, user.id)
    if (!assignment) return null
    if (assignment.owner_id === user.id) return { assignment, teacher: true }
    return assignment.joined_at !== null && assignment.state !== 'draft' ? { assignment, teacher: false } : null
  }

  const uniqueJoinCode = async (): Promise<string> => {
    for (;;) {
      const code = newJoinCode()
      if (!(await db.prepare('SELECT 1 AS yes FROM courses WHERE join_code = ?').bind(code).first())) return code
    }
  }

  const app = new Hono<Env>().basePath('/api')

  app.notFound((c) => c.json({ error: 'There is nothing at this address.' }, 404))
  app.onError((err, c) => {
    console.error('API error:', err)
    return c.json({ error: 'Something went wrong on the server. Please try again.' }, 500)
  })

  // Every answer is JSON that must not be cached, sniffed, framed or used as a script or a page.
  app.use('*', async (c, next) => {
    await next()
    if (!(c.res.headers.get('content-type') ?? '').startsWith('application/json')) {
      c.res = c.json({ error: 'Something went wrong on the server. Please try again.' }, 500)
    }
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox")
    c.header('Cross-Origin-Resource-Policy', 'same-origin')
    c.header('Referrer-Policy', 'no-referrer')
  })

  // Writes must be JSON (which a plain HTML form cannot send) and must come from this site.
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        return fail(c, 415, 'Requests must be sent as JSON.')
      }
      const origin = c.req.header('origin')
      const site = c.req.header('sec-fetch-site')
      let allowed = true
      if (origin) {
        try {
          allowed = new URL(origin).host === new URL(c.req.url).host
        } catch {
          allowed = false
        }
      } else if (site && site !== 'same-origin' && site !== 'none') {
        allowed = false
      }
      if (!allowed) return fail(c, 403, 'Cross-site request blocked.')
    }
    await next()
  })

  // A request is signed in only with BOTH the session cookie and the session secret in the header.
  // The cookie alone (which is all that code in a notebook's worker can send) is worth nothing.
  app.use('*', async (c, next) => {
    c.set('user', null)
    c.set('tokenHash', null)
    const token = getCookie(c, SESSION_COOKIE)
    const secret = c.req.header(SESSION_HEADER)
    if (token && secret && token.length < 200 && secret.length < 200) {
      const tokenHash = await hashToken(token)
      const row = await sql.session(tokenHash)
      const t = now()
      if (row && row.expires_at > t && equalText(row.secret_hash, await hashToken(secret))) {
        const user = await sql.userById(row.user_id)
        if (user) {
          c.set('user', user)
          c.set('tokenHash', tokenHash)
          // Sessions that are in use are extended.
          if (row.expires_at - t < (SESSION_DAYS / 2) * DAY_MS) {
            await db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(t + SESSION_DAYS * DAY_MS, tokenHash).run()
            setCookie(c, SESSION_COOKIE, token, cookieOptions)
          }
        }
      } else if (row && row.expires_at <= t) {
        await sql.deleteSession(tokenHash)
      }
    }
    await next()
  })

  // Writes by a signed-in person are counted, whatever they are.
  app.use('*', async (c, next) => {
    const user = c.get('user')
    if (user && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!(await limiter.hit(`write:${user.id}`, 600, 10 * MINUTE_MS))) return tooMany(c)
    }
    await next()
  })

  // --- Configuration and accounts -----------------------------------------------------------------

  app.get('/config', (c) => c.json(config))

  // Never the session secret: it is handed out once, when the session starts.
  app.get('/auth/session', (c) => {
    const user = c.get('user')
    return c.json({ user: user ? publicUser(user) : null })
  })

  app.post('/auth/register', smallBody, async (c) => {
    if (!(await limiter.hit(`register:${clientIp(c)}`, 10, 60 * MINUTE_MS))) return tooMany(c)
    const body = await readJson(c)
    const email = str(body?.email, 254)?.trim().toLowerCase()
    const password = str(body?.password, LIMITS.passwordMax)
    const name = line(body?.name, LIMITS.name)
    const role = body?.role
    if (!email || !EMAIL.test(email)) return fail(c, 400, 'Enter a valid email address.')
    if (!name) return fail(c, 400, `Enter your name (at most ${LIMITS.name} characters). Your teacher sees it next to your work.`)
    if (role !== 'teacher' && role !== 'student') return fail(c, 400, 'Choose whether you are a teacher or a student.')
    if (!password || password.length < LIMITS.passwordMin) return fail(c, 400, `Use a password with at least ${LIMITS.passwordMin} characters.`)
    if (await sql.userByEmail(email)) return fail(c, 409, 'An account with this email already exists. Sign in instead.')
    const user: UserRow = { id: newId(), email, name, role, password_hash: await hashPassword(password), created_at: now() }
    try {
      await db
        .prepare('INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(user.id, user.email, user.name, user.role, user.password_hash, user.created_at)
        .run()
    } catch {
      // Two sign-ups with the same email at the same moment: the other one won.
      return fail(c, 409, 'An account with this email already exists. Sign in instead.')
    }
    const sessionSecret = await startSession(c, user.id)
    return c.json({ user: publicUser(user), sessionSecret }, 201)
  })

  app.post('/auth/login', smallBody, async (c) => {
    const body = await readJson(c)
    const email = str(body?.email, 254)?.trim().toLowerCase() ?? ''
    const password = str(body?.password, LIMITS.passwordMax) ?? ''
    const ip = clientIp(c)
    // Only failed attempts count against an email, and mostly per address, so that nobody can lock
    // a person out just by typing wrong passwords for them.
    const fromHere = `login-fail:${email}|${ip}`
    const anywhere = `login-fail:${email}`
    if (!(await limiter.hit(`login-ip:${ip}`, 30, 15 * MINUTE_MS)) || (await limiter.blocked(fromHere, 10)) || (await limiter.blocked(anywhere, 100))) {
      return tooMany(c)
    }
    const wrong = async () => {
      await limiter.hit(fromHere, 10, 15 * MINUTE_MS)
      await limiter.hit(anywhere, 100, 60 * MINUTE_MS)
      return fail(c, 401, 'That email and password do not match an account.')
    }
    const user = await sql.userByEmail(email)
    if (!user) {
      await burnPasswordCheck(password)
      return wrong()
    }
    if (!(await verifyPassword(password, user.password_hash))) return wrong()
    await limiter.reset(fromHere)
    // The session this browser had is replaced.
    const old = getCookie(c, SESSION_COOKIE)
    if (old && old.length < 200) await sql.deleteSession(await hashToken(old))
    const sessionSecret = await startSession(c, user.id)
    return c.json({ user: publicUser(user), sessionSecret })
  })

  // Signing out needs the cookie and the secret like everything else: the cookie alone (a request
  // from notebook code) neither ends the session nor removes the cookie.
  app.post('/auth/logout', async (c) => {
    const tokenHash = c.get('tokenHash')
    if (tokenHash) {
      await sql.deleteSession(tokenHash)
      deleteCookie(c, SESSION_COOKIE, { path: '/api', secure: opts.secureCookies })
    }
    return c.json({ ok: true })
  })

  // Forgot password: email a single-use link. The answer is the same whether or not the email has
  // an account, so that nobody can use it to find out who signed up.
  app.post('/auth/forgot', smallBody, async (c) => {
    if (!opts.sendEmail) return fail(c, 503, 'Password reset by email is not switched on for this site.')
    const body = await readJson(c)
    const email = str(body?.email, 254)?.trim().toLowerCase() ?? ''
    if (!EMAIL.test(email)) return fail(c, 400, 'Enter a valid email address.')
    if (!(await limiter.hit(`forgot-ip:${clientIp(c)}`, 10, 60 * MINUTE_MS))) return tooMany(c)
    const sent = c.json({ ok: true })
    // At most three emails an hour to one address, so that the form cannot flood somebody's inbox.
    if (!(await limiter.hit(`forgot:${email}`, 3, 60 * MINUTE_MS))) return sent
    const user = await sql.userByEmail(email)
    if (!user) return sent
    const t = now()
    const token = newToken()
    await db
      .prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await hashToken(token), user.id, t, t + RESET_MINUTES * MINUTE_MS)
      .run()
    const base = (opts.appUrl || new URL(c.req.url).origin).replace(/\/$/, '')
    // The token sits behind "#", so it is never sent to a server as part of an address.
    const message = resetEmail(user, `${base}/reset#token=${encodeURIComponent(token)}`, base, config.controller.contact || undefined)
    const sending = opts.sendEmail(message).catch((err: unknown) => console.error('Password reset email failed:', err))
    try {
      c.executionCtx.waitUntil(sending)
    } catch {
      // Not on Workers: the promise just runs.
    }
    return sent
  })

  app.post('/auth/reset', smallBody, async (c) => {
    if (!(await limiter.hit(`reset-ip:${clientIp(c)}`, 20, 15 * MINUTE_MS))) return tooMany(c)
    const body = await readJson(c)
    const token = str(body?.token, 200) ?? ''
    const password = str(body?.password, LIMITS.passwordMax)
    if (!password || password.length < LIMITS.passwordMin) return fail(c, 400, `Use a password with at least ${LIMITS.passwordMin} characters.`)
    const row = token
      ? await db.prepare('SELECT user_id, expires_at FROM password_resets WHERE token_hash = ?').bind(await hashToken(token)).first<{ user_id: string; expires_at: number }>()
      : null
    const user = row && row.expires_at > now() ? await sql.userById(row.user_id) : null
    if (!user) return fail(c, 400, 'This reset link has expired or was already used. Ask for a new one.')
    // The link is used up, other links are void, and every device is signed out.
    await db.batch([
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), user.id),
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(user.id),
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    ])
    await limiter.reset(`login-fail:${user.email}`)
    const sessionSecret = await startSession(c, user.id)
    return c.json({ user: publicUser(user), sessionSecret })
  })

  app.post('/auth/password', smallBody, async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    if (!(await limiter.hit(`password:${user.id}`, 10, 15 * MINUTE_MS))) return tooMany(c)
    const body = await readJson(c)
    const current = str(body?.currentPassword, LIMITS.passwordMax) ?? ''
    const next = str(body?.newPassword, LIMITS.passwordMax)
    if (!next || next.length < LIMITS.passwordMin) return fail(c, 400, `Use a new password with at least ${LIMITS.passwordMin} characters.`)
    if (!(await verifyPassword(current, user.password_hash))) return fail(c, 403, 'Your current password is not right.')
    // Every other device is signed out.
    await db.batch([
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(next), user.id),
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, c.get('tokenHash') ?? ''),
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(user.id),
    ])
    return c.json({ ok: true })
  })

  app.post('/auth/profile', smallBody, async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const body = await readJson(c)
    const name = body?.name === undefined ? user.name : line(body.name, LIMITS.name)
    const role = body?.role === undefined ? user.role : body.role
    if (!name) return fail(c, 400, `Enter your name (at most ${LIMITS.name} characters).`)
    if (role !== 'teacher' && role !== 'student') return fail(c, 400, 'Choose whether you are a teacher or a student.')
    await db.prepare('UPDATE users SET name = ?, role = ? WHERE id = ?').bind(name, role, user.id).run()
    return c.json({ user: publicUser({ ...user, name, role }) })
  })

  // Deletes the account and, through the foreign keys, everything that belongs to it: its sessions,
  // the courses it owns (with their assignments and every student's work and submissions in them)
  // and its own enrollments, work, submissions and grades.
  app.post('/auth/delete', smallBody, async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    if (!(await limiter.hit(`delete:${user.id}`, 10, 15 * MINUTE_MS))) return tooMany(c)
    const body = await readJson(c)
    if (!(await verifyPassword(str(body?.password, LIMITS.passwordMax) ?? '', user.password_hash))) return fail(c, 403, 'That password is not right.')
    await db.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run()
    deleteCookie(c, SESSION_COOKIE, { path: '/api', secure: opts.secureCookies })
    return c.json({ ok: true })
  })

  // --- Courses --------------------------------------------------------------------------------------

  app.get('/courses', async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const teaching = await db
      .prepare(
        `SELECT c.id, c.name, c.term, c.archived_at, c.created_at,
           (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) AS students,
           (SELECT COUNT(*) FROM assignments a WHERE a.course_id = c.id) AS assignments
         FROM courses c WHERE c.owner_id = ? ORDER BY (c.archived_at IS NOT NULL), c.created_at DESC`,
      )
      .bind(user.id)
      .all<{ id: string; name: string; term: string; archived_at: number | null; created_at: number; students: number; assignments: number }>()
    const enrolled = await db
      .prepare(
        `SELECT c.id, c.name, c.term, c.archived_at, e.joined_at, u.name AS teacher,
           (SELECT COUNT(*) FROM assignments a WHERE a.course_id = c.id AND a.state != 'draft') AS assignments,
           (SELECT COUNT(*) FROM assignments a WHERE a.course_id = c.id AND a.state = 'published'
              AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.assignment_id = a.id AND s.user_id = e.user_id)) AS todo
         FROM enrollments e JOIN courses c ON c.id = e.course_id JOIN users u ON u.id = c.owner_id
         WHERE e.user_id = ? ORDER BY (c.archived_at IS NOT NULL), e.joined_at DESC`,
      )
      .bind(user.id)
      .all<{ id: string; name: string; term: string; archived_at: number | null; joined_at: number; teacher: string; assignments: number; todo: number }>()
    return c.json({
      teaching: teaching.results.map((r) => ({ id: r.id, name: r.name, term: r.term, archived: r.archived_at !== null, students: r.students, assignments: r.assignments })),
      enrolled: enrolled.results.map((r) => ({ id: r.id, name: r.name, term: r.term, archived: r.archived_at !== null, teacher: r.teacher, assignments: r.assignments, todo: r.todo })),
    })
  })

  app.post('/courses', smallBody, async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const body = await readJson(c)
    const name = line(body?.name, LIMITS.courseName)
    const term = line(body?.term ?? '', LIMITS.term)
    const description = prose(body?.description ?? '', LIMITS.description)
    if (!name) return fail(c, 400, `Give the course a name (at most ${LIMITS.courseName} characters).`)
    if (term === null) return fail(c, 400, `The term can have at most ${LIMITS.term} characters.`)
    if (description === null) return fail(c, 400, `The description can have at most ${LIMITS.description} characters.`)
    if ((await sql.count('SELECT COUNT(*) AS n FROM courses WHERE owner_id = ?', user.id)) >= LIMITS.coursesPerTeacher) {
      return fail(c, 409, `You can have at most ${LIMITS.coursesPerTeacher} courses. Delete one you no longer need first.`)
    }
    const t = now()
    const id = newId()
    await db
      .prepare('INSERT INTO courses (id, owner_id, name, term, description, join_code, join_open, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .bind(id, user.id, name, term, description, await uniqueJoinCode(), t, t)
      .run()
    return c.json({ id }, 201)
  })

  // Joining by code. The answer does not say whether a code exists but is switched off.
  app.post('/courses/join', smallBody, async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    if (!(await limiter.hit(`join:${user.id}`, 20, 15 * MINUTE_MS)) || !(await limiter.hit(`join-ip:${clientIp(c)}`, 60, 15 * MINUTE_MS))) return tooMany(c)
    const body = await readJson(c)
    const code = normalizeJoinCode(str(body?.code, 40) ?? '')
    if (!isJoinCode(code)) return fail(c, 400, 'A join code has 8 letters and digits, for example ABCD-EFGH.')
    const course = await db.prepare('SELECT id, owner_id, join_open, archived_at FROM courses WHERE join_code = ?').bind(code).first<CourseRow>()
    if (course && course.owner_id === user.id) return fail(c, 409, 'You teach this course, so you cannot join it as a student.', { id: course.id })
    if (!course || !course.join_open || course.archived_at !== null) {
      return fail(c, 404, 'No course can be joined with this code. Check the code with your teacher.')
    }
    if (await db.prepare('SELECT 1 AS yes FROM enrollments WHERE course_id = ? AND user_id = ?').bind(course.id, user.id).first()) {
      return c.json({ id: course.id, already: true })
    }
    if ((await sql.count('SELECT COUNT(*) AS n FROM enrollments WHERE course_id = ?', course.id)) >= LIMITS.studentsPerCourse) {
      return fail(c, 409, `This course is full (${LIMITS.studentsPerCourse} students). Tell your teacher.`)
    }
    if ((await sql.count('SELECT COUNT(*) AS n FROM enrollments WHERE user_id = ?', user.id)) >= LIMITS.coursesPerStudent) {
      return fail(c, 409, `You can be in at most ${LIMITS.coursesPerStudent} courses. Leave one you no longer need first.`)
    }
    await db.prepare('INSERT INTO enrollments (course_id, user_id, joined_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(course.id, user.id, now()).run()
    return c.json({ id: course.id, already: false }, 201)
  })

  app.get('/courses/:id', async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await courseFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That course')
    const { course } = access
    const base = { id: course.id, name: course.name, term: course.term, description: course.description, archived: course.archived_at !== null }
    if (access.teacher) {
      const roster = await db
        .prepare('SELECT u.id, u.name, u.email, e.joined_at FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.course_id = ? ORDER BY u.name COLLATE NOCASE, u.email')
        .bind(course.id)
        .all<{ id: string; name: string; email: string; joined_at: number }>()
      const assignments = await db
        .prepare(
          `SELECT a.id, a.title, a.state, a.due_at, a.points, a.grades_released_at,
             (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id = a.id) AS submitted,
             (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id = a.id AND s.graded_at IS NOT NULL) AS graded
           FROM assignments a WHERE a.course_id = ? ORDER BY a.created_at`,
        )
        .bind(course.id)
        .all<{ id: string; title: string; state: AssignmentState; due_at: number | null; points: number | null; grades_released_at: number | null; submitted: number; graded: number }>()
      return c.json({
        role: 'teacher',
        course: { ...base, joinCode: course.join_code, joinOpen: Boolean(course.join_open) },
        roster: roster.results.map((r) => ({ id: r.id, name: r.name, email: r.email, joinedAt: r.joined_at })),
        assignments: assignments.results.map((a) => ({
          id: a.id,
          title: a.title,
          state: a.state,
          dueAt: a.due_at,
          points: a.points,
          gradesReleased: a.grades_released_at !== null,
          submitted: a.submitted,
          graded: a.graded,
        })),
      })
    }
    const teacher = await db.prepare('SELECT name FROM users WHERE id = ?').bind(course.owner_id).first<{ name: string }>()
    const assignments = await db
      .prepare(
        `SELECT a.id, a.title, a.state, a.due_at, a.points, a.grades_released_at,
           w.created_at AS started_at, w.updated_at AS work_updated_at,
           s.submitted_at, s.late, s.count, s.checks_passed, s.checks_total, s.grade, s.feedback, s.graded_at
         FROM assignments a
         LEFT JOIN work w ON w.assignment_id = a.id AND w.user_id = ?
         LEFT JOIN submissions s ON s.assignment_id = a.id AND s.user_id = ?
         WHERE a.course_id = ? AND a.state != 'draft'
         ORDER BY (a.due_at IS NULL), a.due_at, a.created_at`,
      )
      .bind(user.id, user.id, course.id)
      .all<StudentWorkRow & { id: string; title: string; state: AssignmentState; due_at: number | null; points: number | null; grades_released_at: number | null }>()
    return c.json({
      role: 'student',
      course: { ...base, teacher: teacher?.name ?? '' },
      assignments: assignments.results.map((a) => ({
        id: a.id,
        title: a.title,
        state: a.state,
        dueAt: a.due_at,
        points: a.points,
        status: statusOf(a),
        submittedAt: a.submitted_at,
        // A grade leaves the server only after the teacher released the grades of this assignment.
        grade: a.grades_released_at !== null ? a.grade : null,
        graded: a.grades_released_at !== null && a.graded_at !== null,
      })),
    })
  })

  app.patch('/courses/:id', smallBody, async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await courseFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That course')
    if (!access.teacher) return fail(c, 403, 'Only the teacher of this course can change it.')
    const { course } = access
    const body = await readJson(c)
    if (!body) return fail(c, 400, 'Nothing to change was sent.')
    const name = body.name === undefined ? course.name : line(body.name, LIMITS.courseName)
    const term = body.term === undefined ? course.term : line(body.term, LIMITS.term)
    const description = body.description === undefined ? course.description : prose(body.description, LIMITS.description)
    if (!name) return fail(c, 400, `Give the course a name (at most ${LIMITS.courseName} characters).`)
    if (term === null) return fail(c, 400, `The term can have at most ${LIMITS.term} characters.`)
    if (description === null) return fail(c, 400, `The description can have at most ${LIMITS.description} characters.`)
    for (const key of ['joinOpen', 'archived'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') return fail(c, 400, `${key} must be true or false.`)
    }
    const joinOpen = body.joinOpen === undefined ? course.join_open : body.joinOpen ? 1 : 0
    const t = now()
    const archivedAt = body.archived === undefined ? course.archived_at : body.archived ? (course.archived_at ?? t) : null
    await db
      .prepare('UPDATE courses SET name = ?, term = ?, description = ?, join_open = ?, archived_at = ?, updated_at = ? WHERE id = ?')
      .bind(name, term, description, joinOpen, archivedAt, t, course.id)
      .run()
    return c.json({ ok: true })
  })

  // A new join code; the old one stops working at once.
  app.post('/courses/:id/code', async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await courseFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That course')
    if (!access.teacher) return fail(c, 403, 'Only the teacher of this course can change its join code.')
    const joinCode = await uniqueJoinCode()
    await db.prepare('UPDATE courses SET join_code = ?, updated_at = ? WHERE id = ?').bind(joinCode, now(), access.course.id).run()
    return c.json({ joinCode })
  })

  app.delete('/courses/:id', async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await courseFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That course')
    if (!access.teacher) return fail(c, 403, 'Only the teacher of this course can delete it.')
    await db.prepare('DELETE FROM courses WHERE id = ?').bind(access.course.id).run()
    return c.json({ ok: true })
  })

  // Removing a student deletes their work, submissions and grades in this course (foreign keys).
  app.delete('/courses/:id/students/:userId', async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await courseFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That course')
    if (!access.teacher) return fail(c, 403, 'Only the teacher of this course can remove students.')
    const studentId = c.req.param('userId')
    const removed = ID_PATTERN.test(studentId)
      ? await db.prepare('DELETE FROM enrollments WHERE course_id = ? AND user_id = ? RETURNING user_id').bind(access.course.id, studentId).first()
      : null
    if (!removed) return notFound(c, 'That student')
    return c.json({ ok: true })
  })

  app.post('/courses/:id/leave', async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await courseFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That course')
    if (access.teacher) return fail(c, 409, 'You teach this course. Archive or delete it instead.')
    await db.prepare('DELETE FROM enrollments WHERE course_id = ? AND user_id = ?').bind(access.course.id, user.id).run()
    return c.json({ ok: true })
  })

  // --- Assignments ----------------------------------------------------------------------------------

  /** The fields of an assignment as sent; `current` supplies what was left out. Returns an error text or the values. */
  const assignmentFields = (body: Record<string, unknown>, current: { title: string | null; instructions: string; due_at: number | null; points: number | null }) => {
    const title = body.title === undefined ? current.title : line(body.title, LIMITS.title)
    const instructions = body.instructions === undefined ? current.instructions : prose(body.instructions, LIMITS.instructions)
    const dueAt = body.dueAt === undefined ? current.due_at : time(body.dueAt)
    const pts = body.points === undefined ? current.points : points(body.points)
    if (!title) return `Give the assignment a title (at most ${LIMITS.title} characters).`
    if (instructions === null) return `The instructions can have at most ${LIMITS.instructions} characters.`
    if (dueAt === undefined) return 'The due date is not a valid date and time.'
    if (pts === undefined) return `Points must be a number from 0 to ${LIMITS.maxPoints}.`
    return { title, instructions, dueAt, points: pts }
  }

  // A new assignment is a draft with an empty notebook; the page then stores the starter.
  app.post('/courses/:id/assignments', smallBody, async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await courseFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That course')
    if (!access.teacher) return fail(c, 403, 'Only the teacher of this course can add assignments.')
    if (access.course.archived_at !== null) return fail(c, 409, 'This course is archived. Bring it back before adding assignments.')
    const fields = assignmentFields((await readJson(c)) ?? {}, { title: null, instructions: '', due_at: null, points: null })
    if (typeof fields === 'string') return fail(c, 400, fields)
    if ((await sql.count('SELECT COUNT(*) AS n FROM assignments WHERE course_id = ?', access.course.id)) >= LIMITS.assignmentsPerCourse) {
      return fail(c, 409, `A course can have at most ${LIMITS.assignmentsPerCourse} assignments. Delete one you no longer need first.`)
    }
    const t = now()
    const id = newId()
    await db
      .prepare(
        `INSERT INTO assignments (id, course_id, title, instructions, due_at, points, state, starter_name, starter_version, starter_updated_at, created_at, updated_at, starter)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', 'notebook.ipynb', 1, ?, ?, ?, ?)`,
      )
      .bind(id, access.course.id, fields.title, fields.instructions, fields.dueAt, fields.points, t, t, t, EMPTY_NOTEBOOK)
      .run()
    return c.json({ id, starterVersion: 1 }, 201)
  })

  app.get('/assignments/:id', async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await assignmentFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That assignment')
    const a = access.assignment
    const course = { id: a.course_id, name: a.course_name, archived: a.archived_at !== null }
    if (access.teacher) {
      const rows = await db
        .prepare(
          `SELECT u.id, u.name, u.email, w.created_at AS started_at, w.updated_at AS work_updated_at,
             s.submitted_at, s.late, s.count, s.checks_passed, s.checks_total, s.grade, s.feedback, s.graded_at
           FROM enrollments e JOIN users u ON u.id = e.user_id
           LEFT JOIN work w ON w.assignment_id = ? AND w.user_id = e.user_id
           LEFT JOIN submissions s ON s.assignment_id = ? AND s.user_id = e.user_id
           WHERE e.course_id = ? ORDER BY u.name COLLATE NOCASE, u.email`,
        )
        .bind(a.id, a.id, a.course_id)
        .all<StudentWorkRow & { id: string; name: string; email: string }>()
      const students = rows.results.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        status: statusOf(r),
        submittedAt: r.submitted_at,
        submissions: r.count ?? 0,
        checksPassed: r.checks_passed,
        checksTotal: r.checks_total,
        grade: r.grade,
        feedback: r.feedback ?? '',
        gradedAt: r.graded_at,
      }))
      const counts = { enrolled: students.length, notStarted: 0, inProgress: 0, submitted: 0, late: 0, graded: 0 }
      for (const s of students) {
        if (s.status === 'not-started') counts.notStarted += 1
        else if (s.status === 'in-progress') counts.inProgress += 1
        else if (s.status === 'late') counts.late += 1
        else counts.submitted += 1
        if (s.gradedAt !== null) counts.graded += 1
      }
      return c.json({
        role: 'teacher',
        course,
        assignment: { ...publicAssignment(a), starter: { name: a.starter_name, version: a.starter_version, updatedAt: a.starter_updated_at } },
        students,
        counts,
      })
    }
    const mine = await db
      .prepare(
        `SELECT w.created_at AS started_at, w.updated_at AS work_updated_at,
           s.submitted_at, s.late, s.count, s.checks_passed, s.checks_total, s.grade, s.feedback, s.graded_at
         FROM (SELECT 1) LEFT JOIN work w ON w.assignment_id = ? AND w.user_id = ?
         LEFT JOIN submissions s ON s.assignment_id = ? AND s.user_id = ?`,
      )
      .bind(a.id, user.id, a.id, user.id)
      .first<StudentWorkRow>()
    const row: StudentWorkRow = mine ?? {
      work_updated_at: null,
      started_at: null,
      submitted_at: null,
      late: null,
      count: null,
      checks_passed: null,
      checks_total: null,
      grade: null,
      feedback: null,
      graded_at: null,
    }
    const released = a.grades_released_at !== null
    return c.json({
      role: 'student',
      course,
      assignment: publicAssignment(a),
      mine: {
        status: statusOf(row),
        submittedAt: row.submitted_at,
        late: Boolean(row.late),
        submissions: row.count ?? 0,
        checksPassed: row.checks_passed,
        checksTotal: row.checks_total,
        // Grade and feedback leave the server only after the teacher released them.
        grade: released ? row.grade : null,
        feedback: released ? (row.feedback ?? '') : '',
        graded: released && row.graded_at !== null,
        // The grade was given for an earlier hand-in than the latest one.
        gradedBeforeLatest: released && row.graded_at !== null && row.submitted_at !== null && row.graded_at < row.submitted_at,
      },
    })
  })

  app.patch('/assignments/:id', smallBody, async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await assignmentFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That assignment')
    if (!access.teacher) return fail(c, 403, 'Only the teacher of this course can change an assignment.')
    const a = access.assignment
    const body = await readJson(c)
    if (!body) return fail(c, 400, 'Nothing to change was sent.')
    const fields = assignmentFields(body, a)
    if (typeof fields === 'string') return fail(c, 400, fields)
    const t = now()
    let state = a.state
    let publishedAt = a.published_at
    if (body.state !== undefined && body.state !== a.state) {
      // draft → published → closed, and a closed assignment can be opened again. Never back to draft:
      // students may already have their copies.
      const allowed = (a.state === 'draft' && body.state === 'published') || (a.state === 'published' && body.state === 'closed') || (a.state === 'closed' && body.state === 'published')
      if (!allowed) return fail(c, 409, `An assignment that is ${a.state} cannot become ${String(body.state)}.`)
      if (a.archived_at !== null && body.state === 'published') return fail(c, 409, 'This course is archived. Bring it back before publishing.')
      state = body.state as AssignmentState
      if (state === 'published' && publishedAt === null) publishedAt = t
    }
    if (body.gradesReleased !== undefined && typeof body.gradesReleased !== 'boolean') return fail(c, 400, 'gradesReleased must be true or false.')
    const releasedAt = body.gradesReleased === undefined ? a.grades_released_at : body.gradesReleased ? (a.grades_released_at ?? t) : null
    await db
      .prepare('UPDATE assignments SET title = ?, instructions = ?, due_at = ?, points = ?, state = ?, published_at = ?, grades_released_at = ?, updated_at = ? WHERE id = ?')
      .bind(fields.title, fields.instructions, fields.dueAt, fields.points, state, publishedAt, releasedAt, t, a.id)
      .run()
    return c.json({ ok: true, state, gradesReleased: releasedAt !== null })
  })

  app.delete('/assignments/:id', async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await assignmentFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That assignment')
    if (!access.teacher) return fail(c, 403, 'Only the teacher of this course can delete an assignment.')
    await db.prepare('DELETE FROM assignments WHERE id = ?').bind(access.assignment.id).run()
    return c.json({ ok: true })
  })

  // The starter notebook, for its teacher only. Students get it as their own copy (below), and only
  // once the assignment is published.
  app.get('/assignments/:id/starter', async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await assignmentFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That assignment')
    if (!access.teacher) return fail(c, 403, 'Only the teacher of this course can open the starter notebook.')
    const a = access.assignment
    const row = await db.prepare('SELECT starter FROM assignments WHERE id = ?').bind(a.id).first<{ starter: string }>()
    if (!row) return notFound(c, 'That assignment')
    return withNotebook(c, { name: a.starter_name, version: a.starter_version, updatedAt: a.starter_updated_at, title: a.title, state: a.state, courseId: a.course_id }, row.starter)
  })

  // Store the starter: the notebook is the request body; `version` is the one the page loaded.
  app.put('/assignments/:id/starter', notebookBody, async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await assignmentFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That assignment')
    if (!access.teacher) return fail(c, 403, 'Only the teacher of this course can change the starter notebook.')
    const a = access.assignment
    const version = Number(c.req.query('version'))
    if (!Number.isInteger(version) || version < 1) return fail(c, 400, 'The version of the notebook is missing.')
    const name = c.req.query('name') === undefined ? a.starter_name : cleanFileName(c.req.query('name'))
    if (!name) return fail(c, 400, 'That file name cannot be used.')
    const notebook = await readNotebook(c)
    if ('response' in notebook) return notebook.response
    const t = now()
    const saved = await db
      .prepare(
        'UPDATE assignments SET starter = ?, starter_name = ?, starter_version = starter_version + 1, starter_updated_at = ?, updated_at = ? WHERE id = ? AND starter_version = ? RETURNING starter_version',
      )
      .bind(notebook.text, name, t, t, a.id, version)
      .first<{ starter_version: number }>()
    if (!saved) {
      return fail(c, 409, 'The starter notebook was changed somewhere else since you loaded it.', { conflict: true, version: a.starter_version, updatedAt: a.starter_updated_at })
    }
    return c.json({ version: saved.starter_version, updatedAt: t, name })
  })

  // A student opens the assignment: the first time, this makes their own copy from the starter.
  app.post('/assignments/:id/work', async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await assignmentFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That assignment')
    if (access.teacher) return fail(c, 403, 'You teach this course. Students get their own copy; you can edit the starter notebook.')
    const a = access.assignment
    const t = now()
    const created = await db
      .prepare(
        `INSERT INTO work (assignment_id, user_id, course_id, version, created_at, updated_at, notebook)
         SELECT a.id, ?, a.course_id, 1, ?, ?, a.starter FROM assignments a WHERE a.id = ?
         ON CONFLICT(assignment_id, user_id) DO NOTHING RETURNING version`,
      )
      .bind(user.id, t, t, a.id)
      .first()
    const row = await db
      .prepare('SELECT version, updated_at, notebook FROM work WHERE assignment_id = ? AND user_id = ?')
      .bind(a.id, user.id)
      .first<{ version: number; updated_at: number; notebook: string }>()
    if (!row) return notFound(c, 'That assignment')
    return withNotebook(c, { name: a.starter_name, version: row.version, updatedAt: row.updated_at, created: Boolean(created) }, row.notebook, created ? 201 : 200)
  })

  // Autosave of the student's copy. `version` is the one the page has; a save on top of an older
  // version is refused with 409, so that a second tab cannot overwrite newer work unseen.
  app.put('/assignments/:id/work', notebookBody, async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await assignmentFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That assignment')
    if (access.teacher) return fail(c, 403, 'You teach this course. Students get their own copy; you can edit the starter notebook.')
    const version = Number(c.req.query('version'))
    if (!Number.isInteger(version) || version < 1) return fail(c, 400, 'The version of the notebook is missing.')
    const notebook = await readNotebook(c)
    if ('response' in notebook) return notebook.response
    const t = now()
    const key = [access.assignment.id, user.id] as const
    const saved = await db
      .prepare('UPDATE work SET notebook = ?, version = version + 1, updated_at = ? WHERE assignment_id = ? AND user_id = ? AND version = ? RETURNING version')
      .bind(notebook.text, t, ...key, version)
      .first<{ version: number }>()
    if (saved) return c.json({ version: saved.version, updatedAt: t })
    const current = await db.prepare('SELECT version, updated_at FROM work WHERE assignment_id = ? AND user_id = ?').bind(...key).first<{ version: number; updated_at: number }>()
    if (!current) return fail(c, 404, 'Open the assignment first, so that your copy exists.')
    return fail(c, 409, 'This notebook was saved somewhere else since you loaded it.', { conflict: true, version: current.version, updatedAt: current.updated_at })
  })

  // Hand in: a snapshot of the saved copy, with the time by the server's clock. Handing in again
  // replaces the snapshot and counts up, until the assignment is closed.
  app.post('/assignments/:id/submit', smallBody, async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await assignmentFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That assignment')
    if (access.teacher) return fail(c, 403, 'You teach this course, so there is nothing for you to hand in.')
    const a = access.assignment
    if (a.state !== 'published') return fail(c, 409, 'This assignment is closed. It no longer takes submissions.', { closed: true })
    if (a.archived_at !== null) return fail(c, 409, 'This course is archived. It no longer takes submissions.', { closed: true })
    const body = await readJson(c)
    const version = body?.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return fail(c, 400, 'The version of the notebook is missing.')
    // What the student's browser says about the check cells. It can be made up; it is stored and
    // shown as a report, never as proof.
    let passed: number | null = null
    let total: number | null = null
    if (body?.checksTotal !== undefined && body.checksTotal !== null) {
      const p = body.checksPassed
      const n = body.checksTotal
      if (typeof p !== 'number' || typeof n !== 'number' || !Number.isInteger(p) || !Number.isInteger(n) || n < 0 || n > MAX_NOTEBOOK_CELLS || p < 0 || p > n) {
        return fail(c, 400, 'The check counts are not valid.')
      }
      passed = p
      total = n
    }
    const t = now()
    const late = a.due_at !== null && t > a.due_at ? 1 : 0
    const saved = await db
      .prepare(
        `INSERT INTO submissions (assignment_id, user_id, course_id, submitted_at, first_submitted_at, count, late, checks_passed, checks_total, notebook)
         SELECT w.assignment_id, w.user_id, w.course_id, ?, ?, 1, ?, ?, ?, w.notebook FROM work w
         WHERE w.assignment_id = ? AND w.user_id = ? AND w.version = ?
         ON CONFLICT(assignment_id, user_id) DO UPDATE SET
           submitted_at = excluded.submitted_at, count = submissions.count + 1, late = excluded.late,
           checks_passed = excluded.checks_passed, checks_total = excluded.checks_total, notebook = excluded.notebook
         RETURNING count`,
      )
      .bind(t, t, late, passed, total, a.id, user.id, version)
      .first<{ count: number }>()
    if (!saved) {
      const current = await db.prepare('SELECT version, updated_at FROM work WHERE assignment_id = ? AND user_id = ?').bind(a.id, user.id).first<{ version: number; updated_at: number }>()
      if (!current) return fail(c, 404, 'Open the assignment first, so that your copy exists.')
      return fail(c, 409, 'Your latest changes are not on the server yet, or the notebook was changed somewhere else. Nothing was handed in.', {
        conflict: true,
        version: current.version,
        updatedAt: current.updated_at,
      })
    }
    return c.json({ submittedAt: t, late: Boolean(late), submissions: saved.count, checksPassed: passed, checksTotal: total })
  })

  // One student's submission, for the teacher: the snapshot as it was handed in.
  app.get('/assignments/:id/submissions/:userId', async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await assignmentFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That assignment')
    if (!access.teacher) return fail(c, 403, 'Only the teacher of this course can open submissions.')
    const a = access.assignment
    const studentId = c.req.param('userId')
    const row = ID_PATTERN.test(studentId)
      ? await db
          .prepare(
            `SELECT u.name, u.email, s.submitted_at, s.late, s.count, s.checks_passed, s.checks_total, s.grade, s.feedback, s.graded_at, s.notebook
             FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.assignment_id = ? AND s.user_id = ?`,
          )
          .bind(a.id, studentId)
          .first<{ name: string; email: string; submitted_at: number; late: number; count: number; checks_passed: number | null; checks_total: number | null; grade: number | null; feedback: string; graded_at: number | null; notebook: string }>()
      : null
    if (!row) return notFound(c, 'That submission')
    return withNotebook(
      c,
      {
        assignment: { id: a.id, title: a.title, points: a.points, dueAt: a.due_at, courseId: a.course_id, courseName: a.course_name, gradesReleased: a.grades_released_at !== null },
        student: { id: studentId, name: row.name, email: row.email },
        name: a.starter_name,
        submittedAt: row.submitted_at,
        late: Boolean(row.late),
        submissions: row.count,
        checksPassed: row.checks_passed,
        checksTotal: row.checks_total,
        grade: row.grade,
        feedback: row.feedback,
        gradedAt: row.graded_at,
      },
      row.notebook,
    )
  })

  // Grade and feedback for one submission. Students see them once the assignment's grades are released.
  app.put('/assignments/:id/submissions/:userId/grade', smallBody, async (c) => {
    const user = c.get('user')
    if (!user) return signIn(c)
    const access = await assignmentFor(user, c.req.param('id'))
    if (!access) return notFound(c, 'That assignment')
    if (!access.teacher) return fail(c, 403, 'Only the teacher of this course can grade.')
    const body = await readJson(c)
    const grade = points(body?.grade ?? null)
    const feedback = prose(body?.feedback ?? '', LIMITS.feedback)
    if (grade === undefined) return fail(c, 400, `A grade is a number from 0 to ${LIMITS.maxPoints}, or empty.`)
    if (feedback === null) return fail(c, 400, `Feedback can have at most ${LIMITS.feedback} characters.`)
    const studentId = c.req.param('userId')
    const t = now()
    const gradedAt = grade === null && feedback === '' ? null : t
    const saved = ID_PATTERN.test(studentId)
      ? await db
          .prepare('UPDATE submissions SET grade = ?, feedback = ?, graded_at = ? WHERE assignment_id = ? AND user_id = ? RETURNING user_id')
          .bind(grade, feedback, gradedAt, access.assignment.id, studentId)
          .first()
      : null
    if (!saved) return notFound(c, 'That submission')
    return c.json({ grade, feedback, gradedAt })
  })

  return app
}

export type Api = ReturnType<typeof createApi>
