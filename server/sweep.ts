import type { SqlDb } from './sql.ts'

/**
 * Delete what has expired: sessions, password reset links and rate-limit windows. Runs once a day
 * (a Cron Trigger on Cloudflare, a timer in the Node server), which is what the privacy page says.
 */
export async function sweepExpired(db: SqlDb, t = Date.now()): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(t).run()
  await db.prepare('DELETE FROM password_resets WHERE expires_at <= ?').bind(t).run()
  await db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(t).run()
}
