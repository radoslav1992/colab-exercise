/**
 * The page's side of the API (server/app.ts).
 *
 * Every request carries two things: the HttpOnly session cookie, which the browser adds by itself,
 * and the session secret in a header, which only this file adds. The secret is handed out once,
 * when a session starts, and kept in this browser's localStorage. Notebook code runs in a Web
 * Worker, which has no localStorage, so it can send the cookie but never the secret, and the
 * server refuses a cookie without the secret.
 *
 * The secret must stay in this file: it is never put into a message to the worker, IndexedDB,
 * Cache Storage, a BroadcastChannel or an address, and requests go to this site's own /api/ only.
 */
import { SESSION_HEADER, type AssignmentState, type Role, type StudentStatus } from '../shared/limits.ts'

const SECRET_KEY = 'notebook-lab:session-secret'
/** In memory too, for browsers whose storage is blocked: the session then lasts until the tab is closed. */
let memorySecret: string | null = null

function readSecret(): string | null {
  try {
    return localStorage.getItem(SECRET_KEY) ?? memorySecret
  } catch {
    return memorySecret
  }
}

function storeSecret(secret: string | null): void {
  memorySecret = secret
  try {
    if (secret) localStorage.setItem(SECRET_KEY, secret)
    else localStorage.removeItem(SECRET_KEY)
  } catch {
    // Storage is blocked: the secret is kept for this visit only.
  }
}

/** Whether this browser holds a session secret, i.e. whether somebody may be signed in. */
export function hasSessionSecret(): boolean {
  return Boolean(readSecret())
}

export function forgetSession(): void {
  storeSecret(null)
}

/** An answer that is not 2xx, or no answer at all (status 0: offline, or the server cannot be reached). */
export class ApiError extends Error {
  readonly status: number
  readonly data: Record<string, unknown>

  constructor(status: number, message: string, data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }

  /** Worth trying again later without the person doing anything. */
  get temporary(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500
  }
}

let onSignedOut: (() => void) | null = null

/** Called when the server says that this browser is not signed in although it holds a session secret. */
export function setSignedOutHandler(handler: () => void): void {
  onSignedOut = handler
}

const ID = /^[a-z0-9]{20}$/

/** An id as a path segment. Anything that is not an id never reaches an address. */
function seg(id: string): string {
  if (!ID.test(id)) throw new ApiError(404, 'That was not found, or you do not have access to it.')
  return id
}

interface RequestOptions {
  /** Sent as JSON. */
  body?: unknown
  /** Sent as it is (a notebook as JSON text). */
  raw?: string
  query?: Record<string, string | number>
}

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const secret = readSecret()
  if (secret) headers[SESSION_HEADER] = secret
  let body: string | undefined
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    body = options.raw ?? JSON.stringify(options.body ?? {})
  }
  const query = options.query ? `?${new URLSearchParams(Object.entries(options.query).map(([k, v]) => [k, String(v)])).toString()}` : ''
  let response: Response
  try {
    // Same origin only, and never along a redirect: the header with the secret must not travel anywhere else.
    response = await fetch(`/api${path}${query}`, { method, headers, body, credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
  } catch {
    throw new ApiError(0, 'The server could not be reached. Check your connection.')
  }
  let data: Record<string, unknown> | null = null
  if ((response.headers.get('content-type') ?? '').startsWith('application/json')) {
    try {
      const parsed: unknown = await response.json()
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
    } catch {
      data = null
    }
  }
  if (!response.ok || !data) {
    const message = typeof data?.error === 'string' ? data.error : `The server answered with an error (${response.status}).`
    if (response.status === 401 && secret && path !== '/auth/login') onSignedOut?.()
    throw new ApiError(response.ok ? 502 : response.status, message, data ?? {})
  }
  // A new session: keep its secret here and hand the rest on without it.
  if (typeof data.sessionSecret === 'string') {
    storeSecret(data.sessionSecret)
    delete data.sessionSecret
  }
  return data as T
}

// --- What the server sends ------------------------------------------------------------------------

export interface User {
  id: string
  email: string
  name: string
  role: Role
  createdAt: number
}

export interface SiteConfig {
  accounts: boolean
  passwordReset: boolean
  controller: { name: string; contact: string }
}

export interface TeachingCourse {
  id: string
  name: string
  term: string
  archived: boolean
  students: number
  assignments: number
}

export interface EnrolledCourse {
  id: string
  name: string
  term: string
  archived: boolean
  teacher: string
  assignments: number
  todo: number
}

interface CourseBase {
  id: string
  name: string
  term: string
  description: string
  archived: boolean
}

export interface TeacherCourseView {
  role: 'teacher'
  course: CourseBase & { joinCode: string; joinOpen: boolean }
  roster: Array<{ id: string; name: string; email: string; joinedAt: number }>
  assignments: Array<{ id: string; title: string; state: AssignmentState; dueAt: number | null; points: number | null; gradesReleased: boolean; submitted: number; graded: number }>
}

export interface StudentCourseView {
  role: 'student'
  course: CourseBase & { teacher: string }
  assignments: Array<{
    id: string
    title: string
    state: AssignmentState
    dueAt: number | null
    points: number | null
    status: StudentStatus
    submittedAt: number | null
    grade: number | null
    graded: boolean
  }>
}

export type CourseView = TeacherCourseView | StudentCourseView

export interface Assignment {
  id: string
  courseId: string
  title: string
  instructions: string
  dueAt: number | null
  points: number | null
  state: AssignmentState
  gradesReleased: boolean
}

export interface StudentRow {
  id: string
  name: string
  email: string
  status: StudentStatus
  submittedAt: number | null
  submissions: number
  checksPassed: number | null
  checksTotal: number | null
  grade: number | null
  feedback: string
  gradedAt: number | null
}

export interface TeacherAssignmentView {
  role: 'teacher'
  course: { id: string; name: string; archived: boolean }
  assignment: Assignment & { starter: { name: string; version: number; updatedAt: number } }
  students: StudentRow[]
  counts: { enrolled: number; notStarted: number; inProgress: number; submitted: number; late: number; graded: number }
}

export interface MyWork {
  status: StudentStatus
  submittedAt: number | null
  late: boolean
  submissions: number
  checksPassed: number | null
  checksTotal: number | null
  grade: number | null
  feedback: string
  graded: boolean
  gradedBeforeLatest: boolean
}

export interface StudentAssignmentView {
  role: 'student'
  course: { id: string; name: string; archived: boolean }
  assignment: Assignment
  mine: MyWork
}

export type AssignmentView = TeacherAssignmentView | StudentAssignmentView

/** A notebook as the server stores it: the parsed `.ipynb` object. It is untrusted input like any notebook file. */
export interface StoredNotebook {
  name: string
  version: number
  updatedAt: number
  notebook: unknown
}

export interface SaveResult {
  version: number
  updatedAt: number
}

export interface SubmitResult {
  submittedAt: number
  late: boolean
  submissions: number
  checksPassed: number | null
  checksTotal: number | null
}

export interface SubmissionView {
  assignment: { id: string; title: string; points: number | null; dueAt: number | null; courseId: string; courseName: string; gradesReleased: boolean }
  student: { id: string; name: string; email: string }
  name: string
  submittedAt: number
  late: boolean
  submissions: number
  checksPassed: number | null
  checksTotal: number | null
  grade: number | null
  feedback: string
  gradedAt: number | null
  notebook: unknown
}

export interface AssignmentFields {
  title?: string
  instructions?: string
  dueAt?: number | null
  points?: number | null
  state?: AssignmentState
  gradesReleased?: boolean
}

// --- The calls --------------------------------------------------------------------------------------

export const api = {
  config: () => request<SiteConfig>('GET', '/config'),
  session: () => request<{ user: User | null }>('GET', '/auth/session'),
  register: (body: { email: string; password: string; name: string; role: Role }) => request<{ user: User }>('POST', '/auth/register', { body }),
  login: (body: { email: string; password: string }) => request<{ user: User }>('POST', '/auth/login', { body }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  forgot: (email: string) => request<{ ok: true }>('POST', '/auth/forgot', { body: { email } }),
  reset: (token: string, password: string) => request<{ user: User }>('POST', '/auth/reset', { body: { token, password } }),
  changePassword: (currentPassword: string, newPassword: string) => request<{ ok: true }>('POST', '/auth/password', { body: { currentPassword, newPassword } }),
  updateProfile: (body: { name?: string; role?: Role }) => request<{ user: User }>('POST', '/auth/profile', { body }),
  deleteAccount: (password: string) => request<{ ok: true }>('POST', '/auth/delete', { body: { password } }),

  courses: () => request<{ teaching: TeachingCourse[]; enrolled: EnrolledCourse[] }>('GET', '/courses'),
  createCourse: (body: { name: string; term: string; description: string }) => request<{ id: string }>('POST', '/courses', { body }),
  joinCourse: (code: string) => request<{ id: string; already: boolean }>('POST', '/courses/join', { body: { code } }),
  course: (id: string) => request<CourseView>('GET', `/courses/${seg(id)}`),
  updateCourse: (id: string, body: { name?: string; term?: string; description?: string; joinOpen?: boolean; archived?: boolean }) =>
    request<{ ok: true }>('PATCH', `/courses/${seg(id)}`, { body }),
  newJoinCode: (id: string) => request<{ joinCode: string }>('POST', `/courses/${seg(id)}/code`),
  deleteCourse: (id: string) => request<{ ok: true }>('DELETE', `/courses/${seg(id)}`),
  removeStudent: (courseId: string, userId: string) => request<{ ok: true }>('DELETE', `/courses/${seg(courseId)}/students/${seg(userId)}`),
  leaveCourse: (id: string) => request<{ ok: true }>('POST', `/courses/${seg(id)}/leave`),

  createAssignment: (courseId: string, body: AssignmentFields) => request<{ id: string; starterVersion: number }>('POST', `/courses/${seg(courseId)}/assignments`, { body }),
  assignment: (id: string) => request<AssignmentView>('GET', `/assignments/${seg(id)}`),
  updateAssignment: (id: string, body: AssignmentFields) => request<{ ok: true; state: AssignmentState; gradesReleased: boolean }>('PATCH', `/assignments/${seg(id)}`, { body }),
  deleteAssignment: (id: string) => request<{ ok: true }>('DELETE', `/assignments/${seg(id)}`),
  starter: (id: string) => request<StoredNotebook & { title: string; state: AssignmentState; courseId: string }>('GET', `/assignments/${seg(id)}/starter`),
  saveStarter: (id: string, notebook: string, version: number, name?: string) =>
    request<SaveResult & { name: string }>('PUT', `/assignments/${seg(id)}/starter`, { raw: notebook, query: name === undefined ? { version } : { version, name } }),
  openWork: (id: string) => request<StoredNotebook & { created: boolean }>('POST', `/assignments/${seg(id)}/work`),
  saveWork: (id: string, notebook: string, version: number) => request<SaveResult>('PUT', `/assignments/${seg(id)}/work`, { raw: notebook, query: { version } }),
  submit: (id: string, body: { version: number; checksPassed: number | null; checksTotal: number | null }) => request<SubmitResult>('POST', `/assignments/${seg(id)}/submit`, { body }),
  submission: (assignmentId: string, userId: string) => request<SubmissionView>('GET', `/assignments/${seg(assignmentId)}/submissions/${seg(userId)}`),
  grade: (assignmentId: string, userId: string, body: { grade: number | null; feedback: string }) =>
    request<{ grade: number | null; feedback: string; gradedAt: number | null }>('PUT', `/assignments/${seg(assignmentId)}/submissions/${seg(userId)}/grade`, { body }),
}
