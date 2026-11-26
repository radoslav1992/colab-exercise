// Local development: the API (SQLite, restarted when server code changes) and the Vite dev server
// for the site, which passes /api on to it. Arguments go to Vite, for example `npm run dev -- --mode e2e`
// for a site that needs no internet (Pyodide from node_modules, stand-ins for the model libraries).
import { spawn } from 'node:child_process'

const port = process.env.PORT ?? '8787'
const procs = [
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--watch', 'server/dev.ts'], { stdio: 'inherit', env: { ...process.env, PORT: port } }),
  spawn('npx', ['vite', ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NOTEBOOK_LAB_API: `http://127.0.0.1:${port}` },
  }),
]

const stop = () => {
  for (const p of procs) p.kill('SIGTERM')
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const p of procs) p.on('exit', (code) => code && stop())
