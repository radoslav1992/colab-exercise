/**
 * Applies migrations/*.sql to a local SQLite database and records each one in a d1_migrations
 * table exactly like `wrangler d1 migrations apply`, so that the same files and bookkeeping work
 * for D1 in production and for SQLite locally.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

export const MIGRATIONS_DIR = resolve(process.env.MIGRATIONS_DIR ?? 'migrations')
export const MIGRATIONS_TABLE = 'd1_migrations'

export interface Migration {
  name: string
  sql: string
}

/** Migration files in order (0001_…, 0002_…). */
export function readMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
}

export function appliedMigrations(db: DatabaseSync): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE}(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );`)
  return (db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`).all() as { name: string }[]).map((r) => r.name)
}

/** Apply every pending migration, each in its own transaction. Safe to run again. */
export function migrate(db: DatabaseSync, migrations: Migration[] = readMigrations()): { applied: string[]; total: number } {
  const done = new Set(appliedMigrations(db))
  const unknown = [...done].filter((name) => !migrations.some((m) => m.name === name))
  if (unknown.length) {
    throw new Error(`The database has migrations this version of Notebook Lab does not know (${unknown.join(', ')}). Update the app before using this database.`)
  }
  const applied: string[] = []
  for (const m of migrations) {
    if (done.has(m.name)) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`).run(m.name)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${m.name} failed: ${(e as Error).message}`)
    }
    applied.push(m.name)
  }
  return { applied, total: migrations.length }
}
