/**
 * Make a password reset link by hand, for when reset emails cannot be sent (no EMAIL binding) or
 * for support. Somebody writes in, you run this, and you send the link to the address of their
 * account, never to another address.
 *
 *   npm run reset-link -- someone@example.edu --base=https://your-site.example     the live site (D1, remote)
 *   npm run reset-link -- someone@example.edu --local                               `wrangler dev`'s local database
 *
 * Other arguments are passed on to `wrangler d1 execute`, for example --persist-to <folder> or
 * --config <file>. The link works once and for 24 hours, on the same /reset page that emails use.
 */
import { execFileSync } from 'node:child_process'
import { hashToken, newToken } from '../server/crypto.ts'

const DATABASE = 'colab-exercise'
const VALID_HOURS = 24
/** A plain email address, the only kind that is put into SQL text here (wrangler has no bound parameters). */
const PLAIN_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/

const args = process.argv.slice(2)
const emailArg = args.find((a) => !a.startsWith('-') && a.includes('@'))
const email = emailArg?.trim().toLowerCase()
const local = args.includes('--local')
const baseArg = args.find((a) => a.startsWith('--base='))?.slice('--base='.length)
const passOn = args.filter((a) => a !== emailArg && a !== '--local' && !a.startsWith('--base='))
const base = (baseArg ?? (local ? 'http://localhost:8787' : '')).replace(/\/$/, '')

if (!email || !PLAIN_EMAIL.test(email) || !base) {
  console.error('Usage: npm run reset-link -- someone@example.edu --base=https://your-site.example   (or --local)')
  process.exit(1)
}

function d1<T>(sql: string): T[] {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DATABASE, local ? '--local' : '--remote', '--json', '--command', sql, ...passOn], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  })
  const batches = JSON.parse(out.slice(out.indexOf('['))) as Array<{ results?: T[] }>
  return batches.flatMap((b) => b.results ?? [])
}

const [user] = d1<{ id: string; name: string }>(`SELECT id, name FROM users WHERE email = '${email}'`)
if (!user) {
  console.error(`No account uses ${email}.`)
  process.exit(1)
}
if (!/^[a-z0-9]+$/.test(user.id)) throw new Error('Unexpected user id')

const token = newToken()
const now = Date.now()
d1(
  `DELETE FROM password_resets WHERE expires_at <= ${now}; ` +
    `INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES ('${await hashToken(token)}', '${user.id}', ${now}, ${now + VALID_HOURS * 3_600_000})`,
)

console.log(`
Password reset link for ${user.name || email}, valid once and for ${VALID_HOURS} hours:

  ${base}/reset#token=${encodeURIComponent(token)}

Send it only to ${email}, the address of the account, even if the request came from somewhere else.
`)
