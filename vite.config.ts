/// <reference types="vitest/config" />
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
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
 * Every view has its own address (src/router.ts), and each address is a real file: a copy of
 * index.html. Cloudflare then serves /course from course.html, reload works on every view, and an
 * address that is none of them is a real 404 (wrangler.jsonc: "not_found_handling": "404-page").
 * The dev server needs nothing: it answers every page address with index.html anyway.
 */
function viewPages(): Plugin {
  let outDir = 'dist'
  return {
    name: 'view-pages',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const index = resolve(outDir, 'index.html')
      if (!existsSync(index)) return
      for (const page of PAGES) cpSync(index, resolve(outDir, `${page}.html`))
    },
  }
}

/** `npm run dev` starts the API next to Vite and passes its address here; `vite` alone has no API (playground only). */
const apiTarget = process.env.NOTEBOOK_LAB_API

export default defineConfig(({ mode }) => ({
  plugins: [offlineRuntime(mode), viewPages()],
  server: apiTarget ? { proxy: { '/api': { target: apiTarget, changeOrigin: false } } } : undefined,
  worker: { format: 'es' as const },
  build: {
    target: 'es2022',
    rollupOptions: {
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
