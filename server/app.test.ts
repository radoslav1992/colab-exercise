/**
 * The API against SQLite (node:sqlite) with the real migration: validation of every route and,
 * above all, who may read and change what.
 */
import { describe, expect, it } from 'vitest'
import { isJoinCode, JOIN_CODE_ALPHABET, LIMITS, MAX_NOTEBOOK_BYTES, SESSION_HEADER } from '../shared/limits.ts'
import { cleanFileName, createApi, ipKey, RESET_MINUTES, SESSION_COOKIE, SESSION_DAYS, type OutgoingEmail } from './app.ts'
import { hashToken } from './crypto.ts'
import { asSqlDb, openDb } from './db.ts'
import { sweepExpired } from './sweep.ts'

const HOST = 'lab.test'
const START = Date.UTC(2026, 10, 2, 9, 0, 0)
const HOUR = 3_600_000

interface Answer {
  status: number
  body: Record<string, any>
  headers: Headers
}

function world(options: { email?: boolean } = {}) {
  const db = openDb(':memory:')
  const clock = { t: START }
  const net = { ip: '203.0.113.7' }
  const emails: OutgoingEmail[] = []
  const api = createApi({
    db: asSqlDb(db),
    secureCookies: false,
    clientIp: () => net.ip,
    now: () => clock.t,
    sendEmail: options.email === false ? undefined : async (m) => void emails.push(m),
    controllerName: 'Test University',
    controllerContact: 'privacy@lab.test',
  })

  /** One browser: a cookie jar and the session secret the page keeps. */
  const browser = () => {
    const state = { cookie: '', secret: '' }
    const call = async (method: string, path: string, body?: unknown, extra: { headers?: Record<string, string>; raw?: string } = {}): Promise<Answer> => {
      const write = method !== 'GET'
      const res = await api.request(`http://${HOST}/api${path}`, {
        method,
        headers: {
          host: HOST,
          ...(write && { 'content-type': 'application/json', origin: `http://${HOST}` }),
          ...(state.cookie && { cookie: state.cookie }),
          ...(state.secret && { [SESSION_HEADER]: state.secret }),
          ...extra.headers,
        },
        body: extra.raw !== undefined ? extra.raw : body === undefined ? undefined : JSON.stringify(body),
      })
      const set = res.headers.get('set-cookie')
      if (set?.startsWith(`${SESSION_COOKIE}=`)) {
        const value = set.split(';')[0]
        state.cookie = value.endsWith('=') ? '' : value
      }
      const text = await res.text()
      let parsed: Record<string, any>
      try {
        parsed = JSON.parse(text) as Record<string, any>
      } catch {
        throw new Error(`${method} ${path} did not answer JSON: ${text.slice(0, 200)}`)
      }
      if (typeof parsed.sessionSecret === 'string') state.secret = parsed.sessionSecret
      return { status: res.status, body: parsed, headers: res.headers }
    }
    return { state, call }
  }

  /** A signed-up person in their own browser. */
  const person = async (name: string, role: 'teacher' | 'student' = 'student') => {
    const b = browser()
    const email = `${name.toLowerCase().replace(/\W+/g, '.')}@lab.test`
    const res = await b.call('POST', '/auth/register', { email, password: `${name} password`, name, role })
    if (res.status !== 201) throw new Error(`sign-up of ${name} failed: ${JSON.stringify(res.body)}`)
    return { ...b, id: res.body.user.id as string, email, password: `${name} password`, name }
  }

  return { db, api, clock, net, emails, browser, person }
}

type World = ReturnType<typeof world>
type Person = Awaited<ReturnType<World['person']>>

function notebook(source: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cells: [{ cell_type: 'code', id: 'c1', metadata: {}, execution_count: null, outputs: [], source: [source] }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
    ...extra,
  })
}

const sourceOf = (nb: any): string => nb.cells[0].source.join('')

/** A teacher with a course, a published assignment whose starter says "starter", and a student in the course. */
async function classroom(w: World) {
  const teacher = await w.person('Tess Teacher', 'teacher')
  const student = await w.person('Sam Student')
  const courseId = (await teacher.call('POST', '/courses', { name: 'NLP 101', term: 'Autumn 2026' })).body.id as string
  const course = (await teacher.call('GET', `/courses/${courseId}`)).body
  const joinCode = course.course.joinCode as string
  expect((await student.call('POST', '/courses/join', { code: joinCode })).status).toBe(201)
  const created = await teacher.call('POST', `/courses/${courseId}/assignments`, { title: 'Homework 1', instructions: 'Do **it**.', dueAt: START + 24 * HOUR, points: 10 })
  expect(created.status).toBe(201)
  const assignmentId = created.body.id as string
  const put = await teacher.call('PUT', `/assignments/${assignmentId}/starter?version=1&name=hw1.ipynb`, undefined, { raw: notebook('# starter') })
  expect(put.status).toBe(200)
  expect((await teacher.call('PATCH', `/assignments/${assignmentId}`, { state: 'published' })).status).toBe(200)
  return { teacher, student, courseId, joinCode, assignmentId }
}

async function join(w: World, joinCode: string, name: string): Promise<Person> {
  const p = await w.person(name)
  expect((await p.call('POST', '/courses/join', { code: joinCode })).status).toBe(201)
  return p
}

describe('every answer', () => {
  it('is JSON that must not be cached or sniffed, also for errors and unknown addresses', async () => {
    const w = world()
    const b = w.browser()
    const answers = [
      await b.call('GET', '/config'),
      await b.call('GET', '/nothing-here'),
      await b.call('GET', '/courses'),
      await b.call('POST', '/auth/login', { email: 'x@lab.test', password: 'wrong password' }),
      await b.call('POST', '/auth/register', undefined, { raw: '{not json' }),
    ]
    expect(answers.map((a) => a.status)).toEqual([200, 404, 401, 401, 400])
    for (const a of answers) {
      expect(a.headers.get('content-type')).toMatch(/^application\/json/)
      expect(a.headers.get('x-content-type-options')).toBe('nosniff')
      expect(a.headers.get('cache-control')).toBe('no-store')
      expect(a.headers.get('content-security-policy')).toContain("default-src 'none'")
      expect(typeof (a.status === 200 ? a.body.accounts : a.body.error)).toMatch(/boolean|string/)
    }
  })

  it('says what the deployment offers at /config, with the data controller from the configuration', async () => {
    const w = world()
    expect((await w.browser().call('GET', '/config')).body).toEqual({
      accounts: true,
      passwordReset: true,
      controller: { name: 'Test University', contact: 'privacy@lab.test' },
    })
    expect((await world({ email: false }).browser().call('GET', '/config')).body.passwordReset).toBe(false)
  })

  it('answers 401 on every route that needs an account when nobody is signed in', async () => {
    const w = world()
    const { assignmentId, courseId, student } = await classroom(w)
    const anonymous = w.browser()
    const routes: Array<[string, string]> = [
      ['POST', '/auth/password'],
      ['POST', '/auth/profile'],
      ['POST', '/auth/delete'],
      ['GET', '/courses'],
      ['POST', '/courses'],
      ['POST', '/courses/join'],
      ['GET', `/courses/${courseId}`],
      ['PATCH', `/courses/${courseId}`],
      ['POST', `/courses/${courseId}/code`],
      ['DELETE', `/courses/${courseId}`],
      ['DELETE', `/courses/${courseId}/students/${student.id}`],
      ['POST', `/courses/${courseId}/leave`],
      ['POST', `/courses/${courseId}/assignments`],
      ['GET', `/assignments/${assignmentId}`],
      ['PATCH', `/assignments/${assignmentId}`],
      ['DELETE', `/assignments/${assignmentId}`],
      ['GET', `/assignments/${assignmentId}/starter`],
      ['PUT', `/assignments/${assignmentId}/starter?version=1`],
      ['POST', `/assignments/${assignmentId}/work`],
      ['PUT', `/assignments/${assignmentId}/work?version=1`],
      ['POST', `/assignments/${assignmentId}/submit`],
      ['GET', `/assignments/${assignmentId}/submissions/${student.id}`],
      ['PUT', `/assignments/${assignmentId}/submissions/${student.id}/grade`],
    ]
    for (const [method, path] of routes) {
      const res = await anonymous.call(method, path, method === 'GET' ? undefined : {})
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(res.body, `${method} ${path}`).toEqual({ error: 'Please sign in.' })
    }
  })
})

describe('accounts', () => {
  it('signs up, signs out and signs back in', async () => {
    const w = world()
    const b = w.browser()
    const reg = await b.call('POST', '/auth/register', { email: ' Ada@Lab.Test ', password: 'correct horse', name: '  Ada  Lovelace ', role: 'teacher' })
    expect(reg.status).toBe(201)
    expect(reg.body.user).toMatchObject({ email: 'ada@lab.test', name: 'Ada  Lovelace', role: 'teacher' })
    expect(reg.headers.get('set-cookie')).toMatch(/HttpOnly/)
    expect(reg.headers.get('set-cookie')).toMatch(/SameSite=Strict/)
    expect(reg.headers.get('set-cookie')).toMatch(/Path=\/api/)
    expect((await b.call('GET', '/auth/session')).body.user).toMatchObject({ email: 'ada@lab.test' })

    expect((await b.call('POST', '/auth/logout', {})).status).toBe(200)
    expect(b.state.cookie).toBe('')
    expect((await b.call('GET', '/auth/session')).body.user).toBeNull()
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })

    expect((await b.call('POST', '/auth/login', { email: 'ada@lab.test', password: 'wrong password' })).status).toBe(401)
    const login = await b.call('POST', '/auth/login', { email: 'ADA@lab.test', password: 'correct horse' })
    expect(login.status).toBe(200)
    expect(login.body.sessionSecret).toMatch(/^[\w-]{40,}$/)
    expect((await b.call('GET', '/courses')).status).toBe(200)
  })

  it('validates sign-up details', async () => {
    const w = world()
    const b = w.browser()
    const good = { email: 'a@b.co', password: 'longenough', name: 'A', role: 'student' }
    expect((await b.call('POST', '/auth/register', { ...good, email: 'nope' })).status).toBe(400)
    expect((await b.call('POST', '/auth/register', { ...good, password: 'short' })).status).toBe(400)
    expect((await b.call('POST', '/auth/register', { ...good, password: 'x'.repeat(201) })).status).toBe(400)
    expect((await b.call('POST', '/auth/register', { ...good, name: '   ' })).status).toBe(400)
    expect((await b.call('POST', '/auth/register', { ...good, name: 'x'.repeat(LIMITS.name + 1) })).status).toBe(400)
    expect((await b.call('POST', '/auth/register', { ...good, role: 'admin' })).status).toBe(400)
    expect((await b.call('POST', '/auth/register', { ...good, role: undefined })).status).toBe(400)
    expect((await b.call('POST', '/auth/register', ['not', 'an', 'object'])).status).toBe(400)
    expect((await b.call('POST', '/auth/register', good)).status).toBe(201)
    expect((await w.browser().call('POST', '/auth/register', { ...good, email: 'A@B.co' })).status).toBe(409)
  })

  it('stores only hashes of the password, the session token and the session secret', async () => {
    const w = world()
    const p = await w.person('Bea')
    const user = w.db.prepare('SELECT password_hash FROM users').get() as { password_hash: string }
    expect(user.password_hash).toMatch(/^pbkdf2-sha256\$100000\$/)
    const token = p.state.cookie.split('=')[1]
    const session = w.db.prepare('SELECT token_hash, secret_hash FROM sessions').get() as { token_hash: string; secret_hash: string }
    expect(session.token_hash).toBe(await hashToken(token))
    expect(session.secret_hash).toBe(await hashToken(p.state.secret))
    const everything = JSON.stringify([w.db.prepare('SELECT * FROM users').all(), w.db.prepare('SELECT * FROM sessions').all()])
    for (const secret of [p.password, token, p.state.secret]) expect(everything).not.toContain(secret)
  })

  it('needs BOTH the session cookie and the session secret in the header', async () => {
    const w = world()
    const { teacher, student, courseId, assignmentId } = await classroom(w)
    const full = { ...teacher.state }

    // The cookie alone: what a notebook cell running in the teacher's browser can send.
    teacher.state.secret = ''
    expect((await teacher.call('GET', '/auth/session')).body).toEqual({ user: null })
    for (const [method, path, body] of [
      ['GET', '/courses'],
      ['GET', `/courses/${courseId}`],
      ['GET', `/assignments/${assignmentId}`],
      ['GET', `/assignments/${assignmentId}/starter`],
      ['PATCH', `/courses/${courseId}`, { name: 'Taken over' }],
      ['DELETE', `/courses/${courseId}`],
      ['DELETE', `/courses/${courseId}/students/${student.id}`],
      ['POST', '/auth/delete', { password: teacher.password }],
      ['POST', '/auth/password', { currentPassword: teacher.password, newPassword: 'another password' }],
    ] as Array<[string, string, unknown?]>) {
      expect((await teacher.call(method, path, method === 'GET' ? undefined : (body ?? {}))).status, `${method} ${path} with the cookie only`).toBe(401)
    }

    // The secret alone, a wrong secret, and another session's secret.
    teacher.state.cookie = ''
    teacher.state.secret = full.secret
    expect((await teacher.call('GET', '/courses')).status).toBe(401)
    teacher.state.cookie = full.cookie
    teacher.state.secret = 'not-the-secret'
    expect((await teacher.call('GET', '/courses')).status).toBe(401)
    teacher.state.secret = student.state.secret
    expect((await teacher.call('GET', '/courses')).status).toBe(401)
    teacher.state.cookie = student.state.cookie
    teacher.state.secret = full.secret
    expect((await teacher.call('GET', '/courses')).status).toBe(401)

    // Signing out with the cookie alone does nothing: the session and the cookie stay.
    teacher.state.cookie = full.cookie
    teacher.state.secret = ''
    const logout = await teacher.call('POST', '/auth/logout', {})
    expect([logout.status, logout.headers.get('set-cookie')]).toEqual([200, null])
    expect(teacher.state.cookie).toBe(full.cookie)

    // Both: signed in, and nothing was changed by the attempts above.
    Object.assign(teacher.state, full)
    const course = await teacher.call('GET', `/courses/${courseId}`)
    expect(course.status).toBe(200)
    expect(course.body.course.name).toBe('NLP 101')
    expect(course.body.roster).toHaveLength(1)
  })

  it('hands out the session secret once, when the session starts, and never again', async () => {
    const w = world()
    const { teacher, student, courseId, assignmentId } = await classroom(w)
    await student.call('POST', `/assignments/${assignmentId}/work`, {})
    const secret = teacher.state.secret
    const answers = [
      await teacher.call('GET', '/auth/session'),
      await teacher.call('GET', '/config'),
      await teacher.call('GET', '/courses'),
      await teacher.call('GET', `/courses/${courseId}`),
      await teacher.call('GET', `/assignments/${assignmentId}`),
      await teacher.call('POST', '/auth/profile', { name: 'Tess T.' }),
      await teacher.call('POST', '/auth/password', { currentPassword: teacher.password, newPassword: 'a new password' }),
    ]
    for (const a of answers) {
      expect(a.status).toBe(200)
      expect(JSON.stringify(a.body)).not.toContain(secret)
      expect(JSON.stringify(a.body)).not.toContain('sessionSecret')
      expect([...a.headers.values()].join('\n')).not.toContain(secret)
    }
  })

  it('refuses writes from other sites and writes that are not JSON', async () => {
    const w = world()
    const p = await w.person('Cy')
    expect((await p.call('POST', '/courses', { name: 'X' }, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await p.call('POST', '/courses', { name: 'X' }, { headers: { origin: 'null' } })).status).toBe(403)
    expect((await p.call('POST', '/courses', { name: 'X' }, { headers: { origin: '', 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await p.call('POST', '/courses', undefined, { raw: 'name=X', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415)
    expect((await p.call('POST', '/courses', undefined, { raw: '{"name":"X"}', headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await p.call('DELETE', '/courses/aaaaaaaaaaaaaaaaaaaa', undefined, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await w.browser().call('POST', '/auth/login', { email: p.email, password: p.password }, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect((await p.call('GET', '/courses')).body.teaching).toEqual([])
    expect((await p.call('POST', '/courses', { name: 'X' })).status).toBe(201)
  })

  it('changes the name and the role', async () => {
    const w = world()
    const p = await w.person('Dee')
    expect((await p.call('POST', '/auth/profile', { name: '' })).status).toBe(400)
    expect((await p.call('POST', '/auth/profile', { name: 'x'.repeat(LIMITS.name + 1) })).status).toBe(400)
    expect((await p.call('POST', '/auth/profile', { role: 'owner' })).status).toBe(400)
    const res = await p.call('POST', '/auth/profile', { name: 'Dee Dee', role: 'teacher' })
    expect(res.body.user).toMatchObject({ name: 'Dee Dee', role: 'teacher' })
    expect((await p.call('GET', '/auth/session')).body.user).toMatchObject({ name: 'Dee Dee', role: 'teacher' })
  })

  it('changes the password and signs out the other devices', async () => {
    const w = world()
    const p = await w.person('Eli')
    const other = w.browser()
    await other.call('POST', '/auth/login', { email: p.email, password: p.password })
    expect((await other.call('GET', '/courses')).status).toBe(200)
    expect((await p.call('POST', '/auth/password', { currentPassword: 'wrong', newPassword: 'new password 1' })).status).toBe(403)
    expect((await p.call('POST', '/auth/password', { currentPassword: p.password, newPassword: 'short' })).status).toBe(400)
    expect((await p.call('POST', '/auth/password', { currentPassword: p.password, newPassword: 'new password 1' })).status).toBe(200)
    expect((await p.call('GET', '/courses')).status).toBe(200)
    expect((await other.call('GET', '/courses')).status).toBe(401)
    expect((await w.browser().call('POST', '/auth/login', { email: p.email, password: p.password })).status).toBe(401)
    expect((await w.browser().call('POST', '/auth/login', { email: p.email, password: 'new password 1' })).status).toBe(200)
  })

  it('deletes an account with its password, and with it everything that belongs to it', async () => {
    const w = world()
    const { teacher, student, assignmentId } = await classroom(w)
    await student.call('POST', `/assignments/${assignmentId}/work`, {})
    await student.call('POST', `/assignments/${assignmentId}/submit`, { version: 1 })
    const count = (table: string) => (w.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

    expect((await student.call('POST', '/auth/delete', { password: 'wrong' })).status).toBe(403)
    expect(count('users')).toBe(2)
    expect((await student.call('POST', '/auth/delete', { password: student.password })).status).toBe(200)
    expect([count('users'), count('enrollments'), count('work'), count('submissions'), count('courses'), count('assignments')]).toEqual([1, 0, 0, 0, 1, 1])
    expect((await student.call('GET', '/courses')).status).toBe(401)
    expect((await w.browser().call('POST', '/auth/login', { email: student.email, password: student.password })).status).toBe(401)

    // A teacher's account takes its courses, their assignments and the students' work in them along.
    const second = await join(w, (await teacher.call('GET', `/courses/${(await teacher.call('GET', '/courses')).body.teaching[0].id}`)).body.course.joinCode, 'Second Student')
    await second.call('POST', `/assignments/${assignmentId}/work`, {})
    await second.call('POST', `/assignments/${assignmentId}/submit`, { version: 1 })
    expect((await teacher.call('POST', '/auth/delete', { password: teacher.password })).status).toBe(200)
    expect([count('users'), count('courses'), count('assignments'), count('enrollments'), count('work'), count('submissions'), count('sessions')]).toEqual([1, 0, 0, 0, 0, 0, 1])
    expect((await second.call('GET', '/courses')).body).toEqual({ teaching: [], enrolled: [] })
  })

  it('emails a single-use reset link that signs every device out', async () => {
    const w = world()
    const p = await w.person('Fay')
    const b = w.browser()
    expect((await b.call('POST', '/auth/forgot', { email: 'nope' })).status).toBe(400)
    expect((await b.call('POST', '/auth/forgot', { email: 'nobody@lab.test' })).body).toEqual({ ok: true })
    expect(w.emails).toHaveLength(0)
    expect((await b.call('POST', '/auth/forgot', { email: p.email })).body).toEqual({ ok: true })
    expect(w.emails).toHaveLength(1)
    expect(w.emails[0].to).toBe(p.email)
    const link = /http:\/\/lab\.test\/reset#token=([\w-]+)/.exec(w.emails[0].text)
    expect(link).not.toBeNull()
    const token = link![1]
    expect(JSON.stringify(w.db.prepare('SELECT * FROM password_resets').all())).not.toContain(token)

    expect((await b.call('POST', '/auth/reset', { token: 'made-up', password: 'new password 2' })).status).toBe(400)
    expect((await b.call('POST', '/auth/reset', { token, password: 'short' })).status).toBe(400)
    const reset = await b.call('POST', '/auth/reset', { token, password: 'new password 2' })
    expect(reset.status).toBe(200)
    expect(reset.body.sessionSecret).toBeTruthy()
    expect((await b.call('GET', '/courses')).status).toBe(200)
    expect((await p.call('GET', '/courses')).status).toBe(401)
    expect((await w.browser().call('POST', '/auth/reset', { token, password: 'new password 3' })).status).toBe(400)

    // A link is good for an hour.
    await b.call('POST', '/auth/forgot', { email: p.email })
    const later = /#token=([\w-]+)/.exec(w.emails[1].text)![1]
    w.clock.t += RESET_MINUTES * 60_000 + 1
    expect((await w.browser().call('POST', '/auth/reset', { token: later, password: 'new password 4' })).status).toBe(400)
  })

  it('answers 503 to "forgot password" when no email can be sent', async () => {
    const w = world({ email: false })
    const p = await w.person('Gus')
    expect((await w.browser().call('POST', '/auth/forgot', { email: p.email })).status).toBe(503)
  })

  it('extends sessions that are in use and forgets expired ones', async () => {
    const w = world()
    const p = await w.person('Hal')
    w.clock.t += (SESSION_DAYS - 1) * 86_400_000
    expect((await p.call('GET', '/courses')).status).toBe(200)
    w.clock.t += (SESSION_DAYS - 1) * 86_400_000
    expect((await p.call('GET', '/courses')).status).toBe(200)
    w.clock.t += (SESSION_DAYS + 1) * 86_400_000
    expect((await p.call('GET', '/courses')).status).toBe(401)
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  })
})

describe('rate limits', () => {
  it('limits sign-ups per address', async () => {
    const w = world()
    for (let i = 0; i < 10; i++) {
      expect((await w.browser().call('POST', '/auth/register', { email: `u${i}@lab.test`, password: 'longenough', name: `U${i}`, role: 'student' })).status).toBe(201)
    }
    expect((await w.browser().call('POST', '/auth/register', { email: 'u10@lab.test', password: 'longenough', name: 'U10', role: 'student' })).status).toBe(429)
    w.net.ip = '203.0.113.8'
    expect((await w.browser().call('POST', '/auth/register', { email: 'u10@lab.test', password: 'longenough', name: 'U10', role: 'student' })).status).toBe(201)
    w.net.ip = '203.0.113.7'
    w.clock.t += HOUR + 1
    expect((await w.browser().call('POST', '/auth/register', { email: 'u11@lab.test', password: 'longenough', name: 'U11', role: 'student' })).status).toBe(201)
  })

  it('limits failed sign-ins for one account from one address, and lets the right password in from elsewhere', async () => {
    const w = world()
    const p = await w.person('Ida')
    for (let i = 0; i < 10; i++) expect((await w.browser().call('POST', '/auth/login', { email: p.email, password: 'guess' })).status).toBe(401)
    expect((await w.browser().call('POST', '/auth/login', { email: p.email, password: p.password })).status).toBe(429)
    w.net.ip = '198.51.100.20'
    expect((await w.browser().call('POST', '/auth/login', { email: p.email, password: p.password })).status).toBe(200)
  })

  it('limits password reset emails to one address', async () => {
    const w = world()
    const p = await w.person('Jo')
    for (let i = 0; i < 5; i++) expect((await w.browser().call('POST', '/auth/forgot', { email: p.email })).status).toBe(200)
    expect(w.emails).toHaveLength(3)
    for (let i = 0; i < 5; i++) await w.browser().call('POST', '/auth/forgot', { email: `x${i}@lab.test` })
    expect((await w.browser().call('POST', '/auth/forgot', { email: 'y@lab.test' })).status).toBe(429)
  })

  it('limits guesses of join codes', async () => {
    const w = world()
    const p = await w.person('Kim')
    for (let i = 0; i < 20; i++) expect((await p.call('POST', '/courses/join', { code: 'ABCDEFGH' })).status).toBe(404)
    expect((await p.call('POST', '/courses/join', { code: 'ABCDEFGH' })).status).toBe(429)
    w.clock.t += 15 * 60_000 + 1
    expect((await p.call('POST', '/courses/join', { code: 'ABCDEFGH' })).status).toBe(404)
  })

  it('limits writes per person', async () => {
    const w = world()
    const p = await w.person('Lou')
    let last = 0
    for (let i = 0; i < 601; i++) last = (await p.call('POST', '/auth/profile', { name: `Lou ${i}` })).status
    expect(last).toBe(429)
    expect((await p.call('GET', '/courses')).status).toBe(200)
    w.clock.t += 10 * 60_000 + 1
    expect((await p.call('POST', '/auth/profile', { name: 'Lou' })).status).toBe(200)
  }, 30_000)
})

describe('courses', () => {
  it('creates a course with a join code of unambiguous characters', async () => {
    const w = world()
    const t = await w.person('Mia', 'teacher')
    expect((await t.call('POST', '/courses', { name: '' })).status).toBe(400)
    expect((await t.call('POST', '/courses', { name: 'x'.repeat(LIMITS.courseName + 1) })).status).toBe(400)
    expect((await t.call('POST', '/courses', { name: 'A', term: 'x'.repeat(LIMITS.term + 1) })).status).toBe(400)
    expect((await t.call('POST', '/courses', { name: 'A', description: 'x'.repeat(LIMITS.description + 1) })).status).toBe(400)
    const created = await t.call('POST', '/courses', { name: ' Speech  and language ', term: 'Spring', description: 'Line one\nLine two' })
    expect(created.status).toBe(201)
    const course = (await t.call('GET', `/courses/${created.body.id}`)).body
    expect(course.role).toBe('teacher')
    expect(course.course).toMatchObject({ name: 'Speech  and language', term: 'Spring', description: 'Line one\nLine two', archived: false, joinOpen: true })
    expect(isJoinCode(course.course.joinCode)).toBe(true)
    for (const char of '0O1IL') expect(JOIN_CODE_ALPHABET).not.toContain(char)
    expect((await t.call('GET', '/courses')).body.teaching).toEqual([{ id: created.body.id, name: 'Speech  and language', term: 'Spring', archived: false, students: 0, assignments: 0 }])
  })

  it('caps the number of courses one person owns', async () => {
    const w = world()
    const t = await w.person('Ned', 'teacher')
    for (let i = 0; i < LIMITS.coursesPerTeacher; i++) expect((await t.call('POST', '/courses', { name: `Course ${i}` })).status).toBe(201)
    const over = await t.call('POST', '/courses', { name: 'One too many' })
    expect(over.status).toBe(409)
    expect(over.body.error).toContain(String(LIMITS.coursesPerTeacher))
  })

  it('lets students join with the code, however it is typed, and shows the teacher the roster', async () => {
    const w = world()
    const { teacher, student, courseId, joinCode } = await classroom(w)
    const typed = `${joinCode.slice(0, 4).toLowerCase()}-${joinCode.slice(4).toLowerCase()} `
    const again = await student.call('POST', '/courses/join', { code: typed })
    expect(again.body).toEqual({ id: courseId, already: true })
    expect((await student.call('POST', '/courses/join', { code: 'short' })).status).toBe(400)
    expect((await student.call('POST', '/courses/join', { code: 12345678 })).status).toBe(400)
    expect((await teacher.call('POST', '/courses/join', { code: joinCode })).status).toBe(409)

    const roster = (await teacher.call('GET', `/courses/${courseId}`)).body.roster
    expect(roster).toEqual([{ id: student.id, name: 'Sam Student', email: student.email, joinedAt: START }])

    // The student sees the course, but neither the join code nor the roster.
    const seen = (await student.call('GET', `/courses/${courseId}`)).body
    expect(seen.role).toBe('student')
    expect(seen.course).toEqual({ id: courseId, name: 'NLP 101', term: 'Autumn 2026', description: '', archived: false, teacher: 'Tess Teacher' })
    expect(JSON.stringify(seen)).not.toContain(joinCode)
    expect(seen.roster).toBeUndefined()
    expect((await student.call('GET', '/courses')).body.enrolled).toEqual([{ id: courseId, name: 'NLP 101', term: 'Autumn 2026', archived: false, teacher: 'Tess Teacher', assignments: 1, todo: 1 }])
  })

  it('a new join code replaces the old one; joining can be switched off; archived courses take nobody', async () => {
    const w = world()
    const { teacher, courseId, joinCode } = await classroom(w)
    const fresh = (await teacher.call('POST', `/courses/${courseId}/code`, {})).body.joinCode as string
    expect(isJoinCode(fresh)).toBe(true)
    expect(fresh).not.toBe(joinCode)
    const a = await w.person('Ann')
    expect((await a.call('POST', '/courses/join', { code: joinCode })).status).toBe(404)
    expect((await a.call('POST', '/courses/join', { code: fresh })).status).toBe(201)

    expect((await teacher.call('PATCH', `/courses/${courseId}`, { joinOpen: 'no' })).status).toBe(400)
    expect((await teacher.call('PATCH', `/courses/${courseId}`, { joinOpen: false })).status).toBe(200)
    const b = await w.person('Bob')
    const closed = await b.call('POST', '/courses/join', { code: fresh })
    expect(closed.status).toBe(404)
    // The same answer as for a code that does not exist.
    expect(closed.body).toEqual((await b.call('POST', '/courses/join', { code: 'ZZZZZZZZ' })).body)

    await teacher.call('PATCH', `/courses/${courseId}`, { joinOpen: true, archived: true })
    expect((await b.call('POST', '/courses/join', { code: fresh })).status).toBe(404)
    expect((await teacher.call('POST', `/courses/${courseId}/assignments`, { title: 'Late addition' })).status).toBe(409)
    await teacher.call('PATCH', `/courses/${courseId}`, { archived: false })
    expect((await b.call('POST', '/courses/join', { code: fresh })).status).toBe(201)
  })

  it('caps the number of students in a course', async () => {
    const w = world()
    const { teacher, courseId, joinCode } = await classroom(w)
    const insert = w.db.prepare('INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    const enroll = w.db.prepare('INSERT INTO enrollments (course_id, user_id, joined_at) VALUES (?, ?, ?)')
    for (let i = 1; i < LIMITS.studentsPerCourse; i++) {
      const id = `filler${String(i).padStart(14, '0')}`
      insert.run(id, `filler${i}@lab.test`, `Filler ${i}`, 'student', 'x', START)
      enroll.run(courseId, id, START)
    }
    const late = await w.person('Zed')
    const full = await late.call('POST', '/courses/join', { code: joinCode })
    expect(full.status).toBe(409)
    expect(full.body.error).toContain('full')
    expect((await teacher.call('GET', `/courses/${courseId}`)).body.roster).toHaveLength(LIMITS.studentsPerCourse)
  })

  it('keeps one teacher out of another teacher\'s course, and people who are not in a course out of it', async () => {
    const w = world()
    const { courseId, assignmentId, student } = await classroom(w)
    const other = await w.person('Olga Other', 'teacher')
    const stranger = await w.person('Stan Stranger')
    for (const who of [other, stranger]) {
      for (const [method, path, body] of [
        ['GET', `/courses/${courseId}`],
        ['PATCH', `/courses/${courseId}`, { name: 'Mine now' }],
        ['POST', `/courses/${courseId}/code`],
        ['DELETE', `/courses/${courseId}`],
        ['DELETE', `/courses/${courseId}/students/${student.id}`],
        ['POST', `/courses/${courseId}/leave`],
        ['POST', `/courses/${courseId}/assignments`, { title: 'Injected' }],
        ['GET', `/assignments/${assignmentId}`],
        ['PATCH', `/assignments/${assignmentId}`, { title: 'Changed' }],
        ['DELETE', `/assignments/${assignmentId}`],
        ['GET', `/assignments/${assignmentId}/starter`],
        ['POST', `/assignments/${assignmentId}/work`],
        ['POST', `/assignments/${assignmentId}/submit`, { version: 1 }],
        ['GET', `/assignments/${assignmentId}/submissions/${student.id}`],
        ['PUT', `/assignments/${assignmentId}/submissions/${student.id}/grade`, { grade: 1 }],
      ] as Array<[string, string, unknown?]>) {
        const res = await who.call(method, path, method === 'GET' ? undefined : (body ?? {}))
        expect(res.status, `${who.name}: ${method} ${path}`).toBe(404)
      }
      expect((await who.call('PUT', `/assignments/${assignmentId}/starter?version=2`, undefined, { raw: notebook('# hijacked') })).status).toBe(404)
      expect((await who.call('PUT', `/assignments/${assignmentId}/work?version=1`, undefined, { raw: notebook('# hijacked') })).status).toBe(404)
      expect((await who.call('GET', '/courses')).body).toEqual({ teaching: [], enrolled: [] })
    }
    // Ids that are not ids.
    expect((await other.call('GET', '/courses/..%2F..%2Fconfig')).status).toBe(404)
    expect((await other.call('GET', "/courses/' OR 1=1 --")).status).toBe(404)
    expect(w.db.prepare('SELECT name FROM courses').all()).toEqual([{ name: 'NLP 101' }])
    expect(w.db.prepare('SELECT title FROM assignments').all()).toEqual([{ title: 'Homework 1' }])
  })

  it('keeps students from doing what only the teacher may', async () => {
    const w = world()
    const { student, courseId, assignmentId } = await classroom(w)
    const mate = await join(w, (w.db.prepare('SELECT join_code FROM courses').get() as { join_code: string }).join_code, 'Mate Student')
    for (const [method, path, body] of [
      ['PATCH', `/courses/${courseId}`, { name: 'Renamed' }],
      ['POST', `/courses/${courseId}/code`],
      ['DELETE', `/courses/${courseId}`],
      ['DELETE', `/courses/${courseId}/students/${mate.id}`],
      ['POST', `/courses/${courseId}/assignments`, { title: 'By a student' }],
      ['PATCH', `/assignments/${assignmentId}`, { title: 'Changed', gradesReleased: true }],
      ['DELETE', `/assignments/${assignmentId}`],
      ['GET', `/assignments/${assignmentId}/starter`],
      ['GET', `/assignments/${assignmentId}/submissions/${mate.id}`],
      ['GET', `/assignments/${assignmentId}/submissions/${student.id}`],
      ['PUT', `/assignments/${assignmentId}/submissions/${student.id}/grade`, { grade: 10 }],
    ] as Array<[string, string, unknown?]>) {
      expect((await student.call(method, path, method === 'GET' ? undefined : (body ?? {}))).status, `${method} ${path}`).toBe(403)
    }
    expect((await student.call('PUT', `/assignments/${assignmentId}/starter?version=2`, undefined, { raw: notebook('# easier') })).status).toBe(403)
  })

  it('removing a student, or leaving, ends access and deletes that student\'s work in the course', async () => {
    const w = world()
    const { teacher, student, courseId, assignmentId, joinCode } = await classroom(w)
    const mate = await join(w, joinCode, 'Mate Student')
    for (const s of [student, mate]) {
      await s.call('POST', `/assignments/${assignmentId}/work`, {})
      await s.call('POST', `/assignments/${assignmentId}/submit`, { version: 1 })
    }
    expect((await teacher.call('DELETE', `/courses/${courseId}/students/nobody`)).status).toBe(404)
    expect((await teacher.call('DELETE', `/courses/${courseId}/students/${student.id}`)).status).toBe(200)
    expect((await teacher.call('DELETE', `/courses/${courseId}/students/${student.id}`)).status).toBe(404)
    for (const [method, path] of [
      ['GET', `/courses/${courseId}`],
      ['GET', `/assignments/${assignmentId}`],
      ['POST', `/assignments/${assignmentId}/work`],
      ['POST', `/assignments/${assignmentId}/submit`],
    ]) {
      expect((await student.call(method, path, method === 'GET' ? undefined : { version: 1 })).status, `${method} ${path}`).toBe(404)
    }
    expect((await student.call('PUT', `/assignments/${assignmentId}/work?version=1`, undefined, { raw: notebook('# still here?') })).status).toBe(404)
    expect((await student.call('GET', '/courses')).body.enrolled).toEqual([])
    expect(w.db.prepare('SELECT user_id FROM work').all()).toEqual([{ user_id: mate.id }])
    expect(w.db.prepare('SELECT user_id FROM submissions').all()).toEqual([{ user_id: mate.id }])

    expect((await teacher.call('POST', `/courses/${courseId}/leave`, {})).status).toBe(409)
    expect((await mate.call('POST', `/courses/${courseId}/leave`, {})).status).toBe(200)
    expect((await mate.call('GET', `/courses/${courseId}`)).status).toBe(404)
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM work').get()).toEqual({ n: 0 })
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM submissions').get()).toEqual({ n: 0 })
    expect((await teacher.call('GET', `/assignments/${assignmentId}`)).body.students).toEqual([])
  })

  it('changes, archives and deletes a course', async () => {
    const w = world()
    const { teacher, student, courseId, assignmentId } = await classroom(w)
    expect((await teacher.call('PATCH', `/courses/${courseId}`, { name: '' })).status).toBe(400)
    expect((await teacher.call('PATCH', `/courses/${courseId}`, { archived: 1 })).status).toBe(400)
    expect((await teacher.call('PATCH', `/courses/${courseId}`, { name: 'NLP 102', term: '', description: 'New text', archived: true })).status).toBe(200)
    expect((await student.call('GET', `/courses/${courseId}`)).body.course).toMatchObject({ name: 'NLP 102', term: '', description: 'New text', archived: true })
    await student.call('POST', `/assignments/${assignmentId}/work`, {})
    expect((await student.call('POST', `/assignments/${assignmentId}/submit`, { version: 1 })).status).toBe(409)

    expect((await teacher.call('DELETE', `/courses/${courseId}`)).status).toBe(200)
    expect((await student.call('GET', `/courses/${courseId}`)).status).toBe(404)
    expect((await student.call('GET', `/assignments/${assignmentId}`)).status).toBe(404)
    for (const table of ['courses', 'enrollments', 'assignments', 'work', 'submissions']) {
      expect(w.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 })
    }
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 2 })
  })
})

describe('assignments', () => {
  it('validates the fields of an assignment', async () => {
    const w = world()
    const { teacher, courseId, assignmentId } = await classroom(w)
    const bad: Array<Record<string, unknown>> = [
      { title: '' },
      { title: 'x'.repeat(LIMITS.title + 1) },
      { title: 'A', instructions: 'x'.repeat(LIMITS.instructions + 1) },
      { title: 'A', dueAt: 'tomorrow' },
      { title: 'A', dueAt: 12.5 },
      { title: 'A', dueAt: Date.UTC(1990, 0, 1) },
      { title: 'A', points: -1 },
      { title: 'A', points: LIMITS.maxPoints + 1 },
      { title: 'A', points: '10' },
    ]
    for (const body of bad) {
      expect((await teacher.call('POST', `/courses/${courseId}/assignments`, body)).status, JSON.stringify(body)).toBe(400)
      if (body.title === 'A') expect((await teacher.call('PATCH', `/assignments/${assignmentId}`, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await teacher.call('PATCH', `/assignments/${assignmentId}`, { gradesReleased: 'yes' })).status).toBe(400)
    expect((await teacher.call('PATCH', `/assignments/${assignmentId}`, { state: 'draft' })).status).toBe(409)
    expect((await teacher.call('PATCH', `/assignments/${assignmentId}`, { state: 'archived' })).status).toBe(409)
    const ok = await teacher.call('PATCH', `/assignments/${assignmentId}`, { title: ' Homework one ', instructions: 'New', dueAt: null, points: 12.345 })
    expect(ok.status).toBe(200)
    expect((await teacher.call('GET', `/assignments/${assignmentId}`)).body.assignment).toMatchObject({ title: 'Homework one', instructions: 'New', dueAt: null, points: 12.35, state: 'published' })
  })

  it('caps the number of assignments in a course', async () => {
    const w = world()
    const { teacher, courseId } = await classroom(w)
    for (let i = 1; i < LIMITS.assignmentsPerCourse; i++) expect((await teacher.call('POST', `/courses/${courseId}/assignments`, { title: `A${i}` })).status).toBe(201)
    expect((await teacher.call('POST', `/courses/${courseId}/assignments`, { title: 'One too many' })).status).toBe(409)
  })

  it('hides a draft from students completely, starter included', async () => {
    const w = world()
    const { teacher, student, courseId } = await classroom(w)
    const draft = (await teacher.call('POST', `/courses/${courseId}/assignments`, { title: 'Secret draft' })).body.id as string
    await teacher.call('PUT', `/assignments/${draft}/starter?version=1`, undefined, { raw: notebook('# not yet') })
    expect((await student.call('GET', `/assignments/${draft}`)).status).toBe(404)
    expect((await student.call('GET', `/assignments/${draft}/starter`)).status).toBe(404)
    expect((await student.call('POST', `/assignments/${draft}/work`, {})).status).toBe(404)
    expect((await student.call('PUT', `/assignments/${draft}/work?version=1`, undefined, { raw: notebook('x') })).status).toBe(404)
    expect((await student.call('POST', `/assignments/${draft}/submit`, { version: 1 })).status).toBe(404)
    const list = (await student.call('GET', `/courses/${courseId}`)).body.assignments
    expect(list.map((a: any) => a.title)).toEqual(['Homework 1'])
    expect(JSON.stringify(list)).not.toContain('Secret draft')
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM work').get()).toEqual({ n: 0 })

    await teacher.call('PATCH', `/assignments/${draft}`, { state: 'published' })
    const opened = await student.call('POST', `/assignments/${draft}/work`, {})
    expect(opened.status).toBe(201)
    expect(sourceOf(opened.body.notebook)).toBe('# not yet')
  })

  it('stores the starter only if it is a notebook of at most 1 MB, and checks the version', async () => {
    const w = world()
    const { teacher, assignmentId } = await classroom(w)
    const put = (query: string, raw: string) => teacher.call('PUT', `/assignments/${assignmentId}/starter${query}`, undefined, { raw })
    expect((await put('', notebook('x'))).status).toBe(400)
    expect((await put('?version=0', notebook('x'))).status).toBe(400)
    expect((await put('?version=2', 'not json')).status).toBe(400)
    expect((await put('?version=2', '{"cells":[]}')).status).toBe(400)
    expect((await put('?version=2', '{"nbformat":3,"cells":[]}')).status).toBe(400)
    expect((await put('?version=2', '{"nbformat":4,"cells":["x"]}')).status).toBe(400)
    expect((await put('?version=2', '[]')).status).toBe(400)
    expect((await put('?version=2&name=..%2F..%2Fetc%2Fpasswd', notebook('x'))).body.name).toBe('_.._etc_passwd.ipynb')
    expect((await put('?version=3&name=%20', notebook('x'))).status).toBe(400)
    const big = await put('?version=3', notebook('x'.repeat(MAX_NOTEBOOK_BYTES)))
    expect(big.status).toBe(413)
    expect(big.body.tooLarge).toBe(true)
    expect((await put('?version=3', notebook('é'.repeat(MAX_NOTEBOOK_BYTES / 2)))).status).toBe(413)
    const stale = await put('?version=1', notebook('# stale'))
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ conflict: true, version: 3 })
    const saved = await put('?version=3&name=week-1.ipynb', notebook('# week 1'))
    expect(saved.body).toMatchObject({ version: 4, name: 'week-1.ipynb' })
    const starter = (await teacher.call('GET', `/assignments/${assignmentId}/starter`)).body
    expect(starter).toMatchObject({ name: 'week-1.ipynb', version: 4, title: 'Homework 1' })
    expect(sourceOf(starter.notebook)).toBe('# week 1')
  })

  it('gives each student their own copy; a replaced starter reaches only students who have not started', async () => {
    const w = world()
    const { teacher, student, assignmentId, joinCode } = await classroom(w)
    const first = await student.call('POST', `/assignments/${assignmentId}/work`, {})
    expect(first.status).toBe(201)
    expect(first.body).toMatchObject({ name: 'hw1.ipynb', version: 1, created: true })
    expect(sourceOf(first.body.notebook)).toBe('# starter')

    await teacher.call('PUT', `/assignments/${assignmentId}/starter?version=2`, undefined, { raw: notebook('# starter, second edition') })
    const again = await student.call('POST', `/assignments/${assignmentId}/work`, {})
    expect(again.status).toBe(200)
    expect(again.body.created).toBe(false)
    expect(sourceOf(again.body.notebook)).toBe('# starter')
    const newcomer = await join(w, joinCode, 'New Comer')
    expect(sourceOf((await newcomer.call('POST', `/assignments/${assignmentId}/work`, {})).body.notebook)).toBe('# starter, second edition')

    // The teacher has no copy and cannot hand in.
    expect((await teacher.call('POST', `/assignments/${assignmentId}/work`, {})).status).toBe(403)
    expect((await teacher.call('PUT', `/assignments/${assignmentId}/work?version=1`, undefined, { raw: notebook('x') })).status).toBe(403)
    expect((await teacher.call('POST', `/assignments/${assignmentId}/submit`, { version: 1 })).status).toBe(403)
  })

  it('saves work with a version check, so that a second tab cannot overwrite newer work unseen', async () => {
    const w = world()
    const { student, assignmentId } = await classroom(w)
    const save = (version: number | string, raw: string) => student.call('PUT', `/assignments/${assignmentId}/work?version=${version}`, undefined, { raw })
    expect((await save(1, notebook('early'))).status).toBe(404) // not opened yet
    await student.call('POST', `/assignments/${assignmentId}/work`, {})
    expect((await save('x', notebook('a'))).status).toBe(400)
    expect((await save(1, '{"nbformat":4}')).status).toBe(400)
    expect((await save(1, notebook('x'.repeat(MAX_NOTEBOOK_BYTES)))).status).toBe(413)

    w.clock.t += 1000
    const tabA = await save(1, notebook('from tab A'))
    expect(tabA.body).toEqual({ version: 2, updatedAt: START + 1000 })
    // Tab B still has version 1.
    const tabB = await save(1, notebook('from tab B'))
    expect(tabB.status).toBe(409)
    expect(tabB.body).toMatchObject({ conflict: true, version: 2, updatedAt: START + 1000 })
    expect(sourceOf((await student.call('POST', `/assignments/${assignmentId}/work`, {})).body.notebook)).toBe('from tab A')
    // "Keep mine": save again on top of the version the server has.
    expect((await save(2, notebook('from tab B'))).body.version).toBe(3)
    const now = await student.call('POST', `/assignments/${assignmentId}/work`, {})
    expect(now.body.version).toBe(3)
    expect(sourceOf(now.body.notebook)).toBe('from tab B')
  })

  it('keeps a notebook that tries to break out of its JSON as plain data', async () => {
    const w = world()
    const { student, teacher, assignmentId } = await classroom(w)
    await student.call('POST', `/assignments/${assignmentId}/work`, {})
    const tricky = notebook('print("</script><script>alert(1)</script>")', { '"},"grade":100,"x":{"': 'y', grade: 100 })
    expect((await student.call('PUT', `/assignments/${assignmentId}/work?version=1`, undefined, { raw: tricky })).status).toBe(200)
    await student.call('POST', `/assignments/${assignmentId}/submit`, { version: 2 })
    const seen = await teacher.call('GET', `/assignments/${assignmentId}/submissions/${student.id}`)
    expect(seen.headers.get('content-type')).toMatch(/^application\/json/)
    expect(seen.body.grade).toBeNull()
    expect(seen.body.notebook).toEqual(JSON.parse(tricky))
    // Something that only looks like a notebook at the start is refused.
    expect((await student.call('PUT', `/assignments/${assignmentId}/work?version=2`, undefined, { raw: `${notebook('x')},"grade":100` })).status).toBe(400)
  })

  it('takes submissions: a snapshot with the server\'s time, late or not, counted, until the assignment is closed', async () => {
    const w = world()
    const { teacher, student, assignmentId } = await classroom(w)
    const submit = (body: unknown) => student.call('POST', `/assignments/${assignmentId}/submit`, body)
    expect((await submit({ version: 1 })).status).toBe(404) // no copy yet
    await student.call('POST', `/assignments/${assignmentId}/work`, {})
    await student.call('PUT', `/assignments/${assignmentId}/work?version=1`, undefined, { raw: notebook('answer = 1') })

    expect((await submit({})).status).toBe(400)
    expect((await submit({ version: 2, checksPassed: 3, checksTotal: 2 })).status).toBe(400)
    expect((await submit({ version: 2, checksPassed: -1, checksTotal: 2 })).status).toBe(400)
    expect((await submit({ version: 2, checksPassed: 1.5, checksTotal: 2 })).status).toBe(400)
    expect((await submit({ version: 2, checksTotal: 2 })).status).toBe(400)
    const stale = await submit({ version: 1, checksPassed: 1, checksTotal: 2 })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ conflict: true, version: 2 })

    w.clock.t += HOUR
    const first = await submit({ version: 2, checksPassed: 1, checksTotal: 2, submittedAt: 0, late: false })
    expect(first.body).toEqual({ submittedAt: START + HOUR, late: false, submissions: 1, checksPassed: 1, checksTotal: 2 })

    // The snapshot does not change when the student goes on working.
    await student.call('PUT', `/assignments/${assignmentId}/work?version=2`, undefined, { raw: notebook('answer = 2') })
    const snapshot = await teacher.call('GET', `/assignments/${assignmentId}/submissions/${student.id}`)
    expect(sourceOf(snapshot.body.notebook)).toBe('answer = 1')
    expect(snapshot.body).toMatchObject({ submittedAt: START + HOUR, late: false, submissions: 1, checksPassed: 1, checksTotal: 2, name: 'hw1.ipynb', student: { id: student.id, name: 'Sam Student' } })

    // After the due time (by the server's clock, whatever the browser says) a submission is late.
    w.clock.t = START + 25 * HOUR
    const second = await submit({ version: 3 })
    expect(second.body).toEqual({ submittedAt: START + 25 * HOUR, late: true, submissions: 2, checksPassed: null, checksTotal: null })
    expect(sourceOf((await teacher.call('GET', `/assignments/${assignmentId}/submissions/${student.id}`)).body.notebook)).toBe('answer = 2')
    expect((await student.call('GET', `/assignments/${assignmentId}`)).body.mine).toMatchObject({ status: 'late', submittedAt: START + 25 * HOUR, late: true, submissions: 2 })

    await teacher.call('PATCH', `/assignments/${assignmentId}`, { state: 'closed' })
    const closed = await submit({ version: 3 })
    expect(closed.status).toBe(409)
    expect(closed.body.closed).toBe(true)
    // The student still has their copy and can keep working on it.
    expect((await student.call('PUT', `/assignments/${assignmentId}/work?version=3`, undefined, { raw: notebook('answer = 3') })).status).toBe(200)
    expect(w.db.prepare('SELECT count FROM submissions').get()).toEqual({ count: 2 })
    await teacher.call('PATCH', `/assignments/${assignmentId}`, { state: 'published' })
    expect((await submit({ version: 4 })).status).toBe(200)
  })

  it('shows the teacher every enrolled student with status, counts, reported checks and grade', async () => {
    const w = world()
    const { teacher, student, assignmentId, joinCode } = await classroom(w)
    const working = await join(w, joinCode, 'Wanda Working')
    const late = await join(w, joinCode, 'Larry Late')
    await join(w, joinCode, 'Nora Notstarted')
    await working.call('POST', `/assignments/${assignmentId}/work`, {})
    await student.call('POST', `/assignments/${assignmentId}/work`, {})
    await student.call('POST', `/assignments/${assignmentId}/submit`, { version: 1, checksPassed: 2, checksTotal: 3 })
    w.clock.t = START + 30 * HOUR
    await late.call('POST', `/assignments/${assignmentId}/work`, {})
    await late.call('POST', `/assignments/${assignmentId}/submit`, { version: 1 })
    await teacher.call('PUT', `/assignments/${assignmentId}/submissions/${student.id}/grade`, { grade: 8.5, feedback: 'Good.' })

    const view = (await teacher.call('GET', `/assignments/${assignmentId}`)).body
    expect(view.role).toBe('teacher')
    expect(view.course).toEqual({ id: expect.any(String), name: 'NLP 101', archived: false })
    expect(view.assignment.starter).toMatchObject({ name: 'hw1.ipynb', version: 2 })
    expect(view.counts).toEqual({ enrolled: 4, notStarted: 1, inProgress: 1, submitted: 1, late: 1, graded: 1 })
    expect(view.students.map((s: any) => [s.name, s.status, s.submissions])).toEqual([
      ['Larry Late', 'late', 1],
      ['Nora Notstarted', 'not-started', 0],
      ['Sam Student', 'submitted', 1],
      ['Wanda Working', 'in-progress', 0],
    ])
    expect(view.students[2]).toEqual({
      id: student.id,
      name: 'Sam Student',
      email: student.email,
      status: 'submitted',
      submittedAt: START,
      submissions: 1,
      checksPassed: 2,
      checksTotal: 3,
      grade: 8.5,
      feedback: 'Good.',
      gradedAt: START + 30 * HOUR,
    })
    // No notebook travels with the table.
    expect(JSON.stringify(view)).not.toContain('nbformat')
    expect((await teacher.call('GET', `/courses/${view.course.id}`)).body.assignments[0]).toMatchObject({ title: 'Homework 1', state: 'published', submitted: 2, graded: 1, gradesReleased: false })
  })

  it('grades a submission; students see grade and feedback only after the release, and only their own', async () => {
    const w = world()
    const { teacher, student, courseId, assignmentId, joinCode } = await classroom(w)
    const mate = await join(w, joinCode, 'Mate Student')
    for (const s of [student, mate]) {
      await s.call('POST', `/assignments/${assignmentId}/work`, {})
      await s.call('POST', `/assignments/${assignmentId}/submit`, { version: 1 })
    }
    const grade = (id: string, body: unknown) => teacher.call('PUT', `/assignments/${assignmentId}/submissions/${id}/grade`, body)
    expect((await grade(student.id, { grade: -1 })).status).toBe(400)
    expect((await grade(student.id, { grade: '9' })).status).toBe(400)
    expect((await grade(student.id, { grade: LIMITS.maxPoints + 0.01 })).status).toBe(400)
    expect((await grade(student.id, { grade: 9, feedback: 'x'.repeat(LIMITS.feedback + 1) })).status).toBe(400)
    expect((await grade('nobody', { grade: 9 })).status).toBe(404)
    const notSubmitted = await join(w, joinCode, 'Nora Notstarted')
    expect((await grade(notSubmitted.id, { grade: 9 })).status).toBe(404)
    expect((await grade(student.id, { grade: 9.256, feedback: ' Well done.\r\nSee cell 3. ' })).body).toEqual({ grade: 9.26, feedback: 'Well done.\nSee cell 3.', gradedAt: START })
    expect((await grade(mate.id, { grade: 4, feedback: 'Private to Mate.' })).status).toBe(200)

    // Before the release: nothing about the grade reaches the student, anywhere.
    const before = [
      await student.call('GET', `/assignments/${assignmentId}`),
      await student.call('GET', `/courses/${courseId}`),
      await student.call('GET', '/courses'),
      await student.call('POST', `/assignments/${assignmentId}/work`, {}),
    ]
    for (const res of before) {
      const text = JSON.stringify(res.body)
      expect(text).not.toContain('Well done')
      expect(text).not.toContain('9.26')
      expect(text).not.toContain('Private to Mate')
    }
    expect(before[0].body.mine).toMatchObject({ grade: null, feedback: '', graded: false })
    expect(before[1].body.assignments[0]).toMatchObject({ grade: null, graded: false })
    expect((await student.call('GET', `/assignments/${assignmentId}/submissions/${student.id}`)).status).toBe(403)

    expect((await teacher.call('PATCH', `/assignments/${assignmentId}`, { gradesReleased: true })).body.gradesReleased).toBe(true)
    const after = (await student.call('GET', `/assignments/${assignmentId}`)).body
    expect(after.mine).toMatchObject({ grade: 9.26, feedback: 'Well done.\nSee cell 3.', graded: true, gradedBeforeLatest: false })
    expect(JSON.stringify(after)).not.toContain('Private to Mate')
    expect((await student.call('GET', `/courses/${courseId}`)).body.assignments[0]).toMatchObject({ grade: 9.26, graded: true })

    // Handing in again after the grade is flagged; taking the release back hides the grade again.
    w.clock.t += HOUR
    await student.call('POST', `/assignments/${assignmentId}/submit`, { version: 1 })
    expect((await student.call('GET', `/assignments/${assignmentId}`)).body.mine.gradedBeforeLatest).toBe(true)
    await teacher.call('PATCH', `/assignments/${assignmentId}`, { gradesReleased: false })
    expect((await student.call('GET', `/assignments/${assignmentId}`)).body.mine).toMatchObject({ grade: null, feedback: '', graded: false })
    // Clearing grade and feedback makes the submission ungraded.
    expect((await grade(student.id, { grade: null, feedback: '' })).body.gradedAt).toBeNull()
  })

  it('deletes an assignment with the work and the submissions that belong to it', async () => {
    const w = world()
    const { teacher, student, courseId, assignmentId } = await classroom(w)
    const other = (await teacher.call('POST', `/courses/${courseId}/assignments`, { title: 'Homework 2' })).body.id as string
    await teacher.call('PATCH', `/assignments/${other}`, { state: 'published' })
    for (const id of [assignmentId, other]) {
      await student.call('POST', `/assignments/${id}/work`, {})
      await student.call('POST', `/assignments/${id}/submit`, { version: 1 })
    }
    expect((await teacher.call('DELETE', `/assignments/${assignmentId}`)).status).toBe(200)
    expect((await student.call('GET', `/assignments/${assignmentId}`)).status).toBe(404)
    expect(w.db.prepare('SELECT assignment_id FROM work').all()).toEqual([{ assignment_id: other }])
    expect(w.db.prepare('SELECT assignment_id FROM submissions').all()).toEqual([{ assignment_id: other }])
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM enrollments').get()).toEqual({ n: 1 })
  })
})

describe('helpers', () => {
  it('makes file names safe to show and to offer as a download', () => {
    expect(cleanFileName('homework.ipynb')).toBe('homework.ipynb')
    expect(cleanFileName('Week 1')).toBe('Week 1.ipynb')
    expect(cleanFileName('a/b\\c:d*e?"f<g>h|i.ipynb')).toBe('a_b_c_d_e_f_g_h_i.ipynb')
    expect(cleanFileName('..hidden')).toBe('hidden.ipynb')
    expect(cleanFileName('line\r\nbreak.ipynb')).toBe('line break.ipynb')
    expect(cleanFileName('')).toBeNull()
    expect(cleanFileName('...')).toBeNull()
    expect(cleanFileName(42)).toBeNull()
    expect(cleanFileName('x'.repeat(LIMITS.fileName + 1))).toBeNull()
  })

  it('keys rate limits by IPv4 address or IPv6 /64', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7')
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(ipKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
  })

  it('sweeps expired sessions, reset links and rate-limit rows, and nothing else', async () => {
    const w = world()
    const p = await w.person('Pat')
    await w.browser().call('POST', '/auth/forgot', { email: p.email })
    const count = (table: string) => (w.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    expect([count('sessions'), count('password_resets'), count('rate_limits') > 0]).toEqual([1, 1, true])
    await sweepExpired(asSqlDb(w.db), START + 1000)
    expect([count('sessions'), count('password_resets'), count('rate_limits') > 0]).toEqual([1, 1, true])
    await sweepExpired(asSqlDb(w.db), START + (SESSION_DAYS + 1) * 86_400_000)
    expect([count('sessions'), count('password_resets'), count('rate_limits'), count('users')]).toEqual([0, 0, 0, 1])
  })
})
