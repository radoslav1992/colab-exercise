/// <reference types="vitest/config" />
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { PAGES } from './src/router.ts'

const PYODIDE_FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']
const TYPES: Record<string, string> = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.zip': 'application/zip', '.json': 'application/json' }

/**
 * Mode "e2e" (`npm run build:e2e`, or `npx vite --mode e2e` for an offline dev server) needs no
 * CDN: Pyodide's core files come from the `pyodide` npm package and the model libraries are
 * replaced by the stubs in tests/stubs (see .env.e2e). The normal build and dev server copy
 * nothing and load everything from jsDelivr (src/config.ts).
 */
function offlineRuntime(mode: string): Plugin {
  let outDir = 'dist'
  return {
    name: 'offline-runtime',
    configResolved(config) {
      outDir = config.build.outDir
    },
    configureServer(server) {
      if (mode !== 'e2e') return
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0]
        const name = path.split('/').pop() ?? ''
        const file = path.startsWith('/pyodide/') && PYODIDE_FILES.includes(name)
          ? resolve('node_modules/pyodide', name)
          : path.startsWith('/stubs/') && /^[\w.-]+\.js$/.test(name)
            ? resolve('tests/stubs', name)
            : null
        if (!file || !existsSync(file)) return next()
        response.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream')
        response.end(readFileSync(file))
      })
    },
    closeBundle() {
      if (mode !== 'e2e') return
      const out = resolve(outDir)
      mkdirSync(resolve(out, 'pyodide'), { recursive: true })
      for (const file of PYODIDE_FILES) {
        cpSync(resolve('node_modules/pyodide', file), resolve(out, 'pyodide', file))
      }
      cpSync(resolve('tests/stubs'), resolve(out, 'stubs'), { recursive: true })
    },
  }
}

/**
 * The site has three documents: index.html (the landing page at "/"), app.html (the app) and
 * 404.html. Every view of the app has its own address (src/router.ts), and each address is a real
 * file: app.html is written as playground.html, courses.html, course.html, ... and is itself not
 * kept. Cloudflare then serves /course from course.html, reload works on every view, and an
 * address that is none of them is a real 404 (wrangler.jsonc: "not_found_handling": "404-page").
 * The dev server answers the same addresses with app.html.
 */
function viewPages(): Plugin {
  let outDir = 'dist'
  return {
    name: 'view-pages',
    configResolved(config) {
      outDir = config.build.outDir
    },
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const [path, query] = (request.url ?? '').split('?')
        const page = path.replace(/\/+$/, '').slice(1)
        if ((PAGES as readonly string[]).includes(page)) request.url = `/app.html${query ? `?${query}` : ''}`
        next()
      })
    },
    closeBundle() {
      const app = resolve(outDir, 'app.html')
      if (!existsSync(app)) return
      for (const page of PAGES) cpSync(app, resolve(outDir, `${page}.html`))
      rmSync(app)
    },
  }
}

/**
 * Doodles are files (src/doodles/*.svg, drawn by scripts/doodles.mjs). A page that is a document,
 * like the landing page, gets them written into its HTML here, when the site is built, so that
 * they are there without JavaScript and take the colours of the theme:
 *
 *   <!-- doodle:plane -->                    the file as it is
 *   <!-- doodle:arrow-1 draw -->             with more class names
 */
function inlineDoodles(): Plugin {
  return {
    name: 'inline-doodles',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/<!-- doodle:([a-z0-9-]+)((?: [a-z0-9-]+)*) -->/g, (_match, name: string, classes: string) => {
          const file = resolve('src/doodles', `${name}.svg`)
          if (!existsSync(file)) throw new Error(`There is no doodle called "${name}" (src/doodles/${name}.svg). Run node scripts/doodles.mjs.`)
          let svg = readFileSync(file, 'utf8').trim().replace(`class="doodle doodle-${name}"`, `class="doodle doodle-${name}${classes}"`)
          // A doodle with the class "draw" draws itself in (src/landing.css): every stroke then counts as one unit long.
          if (classes.split(' ').includes('draw')) svg = svg.replace(/<path /g, '<path pathLength="1" ')
          return svg
        })
      },
    },
  }
}

/** `npm run dev` starts the API next to Vite and passes its address here; `vite` alone has no API (playground only). */
const apiTarget = process.env.NOTEBOOK_LAB_API

export default defineConfig(({ mode }) => ({
  plugins: [offlineRuntime(mode), viewPages(), inlineDoodles()],
  // Three documents, no fallback to index.html: an unknown address is a 404 in development too.
  appType: 'mpa' as const,
  server: apiTarget ? { proxy: { '/api': { target: apiTarget, changeOrigin: false } } } : undefined,
  worker: { format: 'es' as const },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { index: 'index.html', app: 'app.html', 'not-found': '404.html' },
      output: {
        manualChunks: {
          editor: ['@codemirror/state', '@codemirror/view', '@codemirror/commands', '@codemirror/language', '@codemirror/lang-python', '@lezer/highlight'],
          markdown: ['katex', 'marked', 'dompurify'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts', 'shared/**/*.test.ts', 'tests/unit/**/*.test.ts'],
  },
}))
