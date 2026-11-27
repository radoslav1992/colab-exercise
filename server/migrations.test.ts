/**
 * The migration against an empty database: it applies cleanly, statement by statement (as D1 runs
 * it), can run again, and its foreign keys delete what they should and nothing else.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { appliedMigrations, migrate, readMigrations } from './migrations.ts'

const files = readMigrations()

function statements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.replace(/--.*$/gm, '').trim())
    .filter(Boolean)
}

const names = (db: DatabaseSync, type: string) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type) as { name: string }[]).map((r) => r.name)

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

/** Two teachers with a course each, two students in the first course, two assignments, work and submissions. */
function populated(): DatabaseSync {
  const db = openDb(':memory:')
  const user = db.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, 'hash', 1)")
  for (const [id, role] of [['t1', 'teacher'], ['t2', 'teacher'], ['s1', 'student'], ['s2', 'student']]) user.run(id, `${id}@x.test`, id, role)
  for (const id of ['t1', 't2', 's1', 's2']) db.prepare("INSERT INTO sessions (token_hash, secret_hash, user_id, created_at, expires_at) VALUES (?, 'secret-hash', ?, 1, 2)").run(`token-${id}`, id)
  db.prepare("INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES ('reset-s1', 's1', 1, 2)").run()
  const course = db.prepare('INSERT INTO courses (id, owner_id, name, join_code, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
  course.run('c1', 't1', 'Course 1', 'AAAAAAAA')
  course.run('c2', 't2', 'Course 2', 'BBBBBBBB')
  const enroll = db.prepare('INSERT INTO enrollments (course_id, user_id, joined_at) VALUES (?, ?, 1)')
  for (const [c, u] of [['c1', 's1'], ['c1', 's2'], ['c2', 's1']]) enroll.run(c, u)
  const assignment = db.prepare("INSERT INTO assignments (id, course_id, title, starter_updated_at, created_at, updated_at, starter) VALUES (?, ?, ?, 1, 1, 1, '{}')")
  for (const [a, c] of [['a1', 'c1'], ['a2', 'c1'], ['a3', 'c2']]) assignment.run(a, c, a)
  const work = db.prepare("INSERT INTO work (assignment_id, user_id, course_id, created_at, updated_at, notebook) VALUES (?, ?, ?, 1, 1, '{}')")
  const submission = db.prepare("INSERT INTO submissions (assignment_id, user_id, course_id, submitted_at, first_submitted_at, notebook) VALUES (?, ?, ?, 1, 1, '{}')")
  for (const [a, u, c] of [['a1', 's1', 'c1'], ['a1', 's2', 'c1'], ['a2', 's1', 'c1'], ['a3', 's1', 'c2']]) {
    work.run(a, u, c)
    submission.run(a, u, c)
  }
  return db
}

const totals = (db: DatabaseSync) =>
  Object.fromEntries(['users', 'sessions', 'password_resets', 'courses', 'enrollments', 'assignments', 'work', 'submissions'].map((t) => [t, count(db, t)]))

describe('migrations', () => {
  it('are numbered files in order, as wrangler expects; there is exactly one', () => {
    expect(files.map((m) => m.name)).toEqual(['0001_init.sql'])
  })

  it('use only statements that are valid on their own and can run more than once', () => {
    for (const m of files) {
      for (const stmt of statements(m.sql)) {
        expect(stmt, `${m.name}: ${stmt.slice(0, 50)}`).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/i)
      }
      // No triggers or transactions: D1 runs a migration statement by statement.
      expect(m.sql).not.toMatch(/\b(TRIGGER|BEGIN|COMMIT|PRAGMA)\b/i)
    }
  })

  it('apply to an empty database, one statement at a time, and again without failing', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    for (let round = 0; round < 2; round++) {
      for (const m of files) for (const stmt of statements(m.sql)) db.exec(`${stmt};`)
    }
    expect(names(db, 'table')).toEqual(['assignments', 'courses', 'enrollments', 'password_resets', 'rate_limits', 'sessions', 'submissions', 'users', 'work'])
    expect(names(db, 'index')).toEqual([
      'assignments_by_course',
      'courses_by_owner',
      'enrollments_by_user',
      'password_resets_by_expiry',
      'password_resets_by_user',
      'rate_limits_by_reset',
      'sessions_by_expiry',
      'sessions_by_user',
      'submissions_by_enrollment',
      'work_by_enrollment',
    ])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
  })

  it('are recorded the way `wrangler d1 migrations apply` records them', () => {
    const db = new DatabaseSync(':memory:')
    expect(migrate(db).applied).toEqual(['0001_init.sql'])
    expect(migrate(db).applied).toEqual([])
    expect(appliedMigrations(db)).toEqual(['0001_init.sql'])
  })

  it('keep the notebook last in its table, so that lists do not read it', () => {
    const db = openDb(':memory:')
    for (const [table, column] of [['assignments', 'starter'], ['work', 'notebook'], ['submissions', 'notebook']]) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
      expect(columns.at(-1), table).toBe(column)
    }
  })

  it('refuse rows that point nowhere or disagree with each other', () => {
    const db = populated()
    const fails = (sql: string) => expect(() => db.exec(sql), sql).toThrow(/constraint/i)
    fails("INSERT INTO sessions (token_hash, secret_hash, user_id, created_at, expires_at) VALUES ('x', 'y', 'nobody', 1, 2)")
    fails("INSERT INTO courses (id, owner_id, name, join_code, created_at, updated_at) VALUES ('c9', 'nobody', 'X', 'CCCCCCCC', 1, 1)")
    fails("INSERT INTO courses (id, owner_id, name, join_code, created_at, updated_at) VALUES ('c9', 't1', 'X', 'AAAAAAAA', 1, 1)") // join code taken
    fails("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES ('u9', 't1@x.test', 'X', 'teacher', 'h', 1)") // email taken
    fails("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES ('u9', 'u9@x.test', 'X', 'admin', 'h', 1)")
    fails("INSERT INTO enrollments (course_id, user_id, joined_at) VALUES ('c1', 's1', 1)") // twice
    fails("UPDATE assignments SET state = 'archived' WHERE id = 'a1'")
    // Work for a student who is not in the course, and work that names the wrong course for its assignment.
    fails("INSERT INTO work (assignment_id, user_id, course_id, created_at, updated_at, notebook) VALUES ('a3', 's2', 'c2', 1, 1, '{}')")
    fails("INSERT INTO work (assignment_id, user_id, course_id, created_at, updated_at, notebook) VALUES ('a3', 's2', 'c1', 1, 1, '{}')")
    fails("INSERT INTO submissions (assignment_id, user_id, course_id, submitted_at, first_submitted_at, notebook) VALUES ('a3', 's2', 'c1', 1, 1, '{}')")
    fails("INSERT INTO work (assignment_id, user_id, course_id, created_at, updated_at, notebook) VALUES ('a1', 's1', 'c1', 1, 1, '{}')") // one copy per student
  })

  it('deleting a student account removes their sessions, enrollments, work and submissions, and nothing of anyone else', () => {
    const db = populated()
    expect(totals(db)).toEqual({ users: 4, sessions: 4, password_resets: 1, courses: 2, enrollments: 3, assignments: 3, work: 4, submissions: 4 })
    db.exec("DELETE FROM users WHERE id = 's1'")
    expect(totals(db)).toEqual({ users: 3, sessions: 3, password_resets: 0, courses: 2, enrollments: 1, assignments: 3, work: 1, submissions: 1 })
    expect(db.prepare('SELECT assignment_id, user_id FROM submissions').all()).toEqual([{ assignment_id: 'a1', user_id: 's2' }])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('deleting a teacher account removes their courses with assignments, enrollments, work and submissions', () => {
    const db = populated()
    db.exec("DELETE FROM users WHERE id = 't1'")
    expect(totals(db)).toEqual({ users: 3, sessions: 3, password_resets: 1, courses: 1, enrollments: 1, assignments: 1, work: 1, submissions: 1 })
    expect(db.prepare('SELECT assignment_id, user_id FROM work').all()).toEqual([{ assignment_id: 'a3', user_id: 's1' }])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('deleting a course removes its enrollments, assignments, work and submissions, and no accounts', () => {
    const db = populated()
    db.exec("DELETE FROM courses WHERE id = 'c1'")
    expect(totals(db)).toEqual({ users: 4, sessions: 4, password_resets: 1, courses: 1, enrollments: 1, assignments: 1, work: 1, submissions: 1 })
  })

  it('deleting an assignment removes its work and submissions only', () => {
    const db = populated()
    db.exec("DELETE FROM assignments WHERE id = 'a1'")
    expect(totals(db)).toEqual({ users: 4, sessions: 4, password_resets: 1, courses: 2, enrollments: 3, assignments: 2, work: 2, submissions: 2 })
    expect(db.prepare('SELECT assignment_id FROM work ORDER BY assignment_id').all()).toEqual([{ assignment_id: 'a2' }, { assignment_id: 'a3' }])
  })

  it('deleting an enrollment (leaving, or being removed) removes that student\'s work and submissions in that course', () => {
    const db = populated()
    db.exec("DELETE FROM enrollments WHERE course_id = 'c1' AND user_id = 's1'")
    expect(totals(db)).toEqual({ users: 4, sessions: 4, password_resets: 1, courses: 2, enrollments: 2, assignments: 3, work: 2, submissions: 2 })
    expect(db.prepare('SELECT assignment_id, user_id FROM work ORDER BY assignment_id').all()).toEqual([
      { assignment_id: 'a1', user_id: 's2' },
      { assignment_id: 'a3', user_id: 's1' },
    ])
  })
})
