/**
 * Local server.
 *
 *   node server/dev.ts            the API only, on port 8787 (`npm run dev` adds Vite for the site)
 *   node server/dev.ts --site     the API and the built site (./dist) on port 8787, with the
 *                                 headers of public/_headers, the way Cloudflare serves it
 *
 * The database is a SQLite file (DATABASE_PATH, default ./.data/notebook-lab.db) with the same
 * schema as D1 (migrations/). Password reset emails are printed here instead of being sent.
 */
import { startServer } from './server.ts'

const env = process.env
const withSite = process.argv.includes('--site')
const server = await startServer({
  port: Number(env.PORT ?? 8787),
  databasePath: env.DATABASE_PATH ?? './.data/notebook-lab.db',
  site: withSite ? { root: env.SITE_DIR ?? './dist', headersFile: './public/_headers' } : null,
  appUrl: env.APP_URL,
  controllerName: env.CONTROLLER_NAME,
  controllerContact: env.CONTROLLER_CONTACT,
  sendEmail: env.NO_EMAIL ? undefined : async (m) => console.log(`\n[email to ${m.to}] ${m.subject}\n\n${m.text}\n`),
})
console.log(`Notebook Lab ${withSite ? 'site and API' : 'API'} on ${server.url} (database: ${env.DATABASE_PATH ?? './.data/notebook-lab.db'})`)

const stop = () => void server.close().then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
