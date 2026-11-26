/**
 * SQLite for local development and tests, behind the same D1-style interface (server/sql.ts) that
 * the Cloudflare Worker uses.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { migrate } from './migrations.ts'
import type { SqlDb, SqlStatement } from './sql.ts'

class SqliteStatement implements SqlStatement {
  private readonly stmt: StatementSync
  private readonly params: SQLInputValue[]

  constructor(stmt: StatementSync, params: SQLInputValue[] = []) {
    this.stmt = stmt
    this.params = params
  }

  bind(...values: unknown[]): SqlStatement {
    return new SqliteStatement(this.stmt, values as SQLInputValue[])
  }

  async first<T>(): Promise<T | null> {
    return (this.stmt.get(...this.params) as T | undefined) ?? null
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.stmt.all(...this.params) as T[] }
  }

  async run(): Promise<unknown> {
    return this.stmt.run(...this.params)
  }
}

/** Wrap a node:sqlite database in the D1-style interface. */
export function asSqlDb(db: DatabaseSync): SqlDb {
  return {
    prepare: (sql) => new SqliteStatement(db.prepare(sql)),
    async batch(statements) {
      db.exec('BEGIN')
      try {
        for (const statement of statements) await statement.run()
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
}

/**
 * Open (and create if needed) a SQLite database. Use ":memory:" in tests. Pending migrations from
 * ./migrations run unless `autoMigrate` is false. Foreign keys are enforced, as in D1.
 */
export function openDb(path: string, { autoMigrate = true }: { autoMigrate?: boolean } = {}): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON;')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;')
  if (autoMigrate) migrate(db)
  return db
}
