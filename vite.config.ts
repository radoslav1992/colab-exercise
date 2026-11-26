/// <reference types="vitest/config" />
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

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

export default defineConfig(({ mode }) => ({
  plugins: [offlineRuntime(mode)],
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
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
  },
}))
