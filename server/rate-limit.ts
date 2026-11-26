import type { SqlDb } from './sql.ts'

/**
 * Fixed-window rate limits stored in the database, so that they hold across every Worker instance
 * (or server process) that handles requests.
 */
export class RateLimiter {
  private readonly db: SqlDb
  private readonly now: () => number

  constructor(db: SqlDb, now: () => number = Date.now) {
    this.db = db
    this.now = now
  }

  /** Count a hit for `key`. Resolves false when the limit is already used up. */
  async hit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const t = this.now()
    const row = await this.db
      .prepare(
        `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
           reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
         RETURNING count`,
      )
      .bind(key, t + windowMs, t, t)
      .first<{ count: number }>()
    return (row?.count ?? 1) <= limit
  }

  /** Whether `key` has used up its limit, without counting a hit. */
  async blocked(key: string, limit: number): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?')
      .bind(key)
      .first<{ count: number; reset_at: number }>()
    return !!row && row.reset_at > this.now() && row.count >= limit
  }

  async reset(key: string): Promise<void> {
    await this.db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run()
  }
}
