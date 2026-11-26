/** Things that must stay true about the project as a whole: pinned versions, headers, sample files. */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { config, HF_INFERENCE_VERSION, PYODIDE_VERSION, TRANSFORMERS_VERSION } from '../../src/config.ts'
import { samples } from '../../src/samples.ts'
import { parseHeaders } from '../e2e/server.mjs'

describe('versions', () => {
  it('pins exact versions of everything that is loaded at run time', () => {
    for (const version of [PYODIDE_VERSION, TRANSFORMERS_VERSION, HF_INFERENCE_VERSION]) expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(config.pyodideIndexUrl).toBe(`https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`)
    expect(config.transformersUrl).toBe(`https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`)
    expect(config.hfInferenceUrl).toBe(`https://cdn.jsdelivr.net/npm/@huggingface/inference@${HF_INFERENCE_VERSION}/+esm`)
  })

  it('tests against the same Pyodide version that production loads from the CDN', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies: Record<string, string> }
    expect(pkg.devDependencies.pyodide).toBe(PYODIDE_VERSION)
    const installed = JSON.parse(readFileSync('node_modules/pyodide/package.json', 'utf8')) as { version: string }
    expect(installed.version).toBe(PYODIDE_VERSION)
    // The loader builds its package address from its own version, in exactly this form.
    expect(readFileSync('node_modules/pyodide/pyodide.mjs', 'utf8')).toContain('https://cdn.jsdelivr.net/pyodide/v${')
  })
})

describe('public/_headers', () => {
  const rules = parseHeaders(readFileSync('public/_headers', 'utf8'))
  const all = Object.fromEntries(rules.find((rule) => rule.pattern.test('/index.html'))!.headers.map(([name, value]) => [name.toLowerCase(), value]))

  it('sets a Content-Security-Policy without inline or eval scripts', () => {
    const csp = Object.fromEntries(
      all['content-security-policy'].split(';').map((part) => {
        const [name, ...values] = part.trim().split(/\s+/)
        return [name, values]
      }),
    )
    expect(csp['default-src']).toEqual(["'self'"])
    expect(csp['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'", 'https://cdn.jsdelivr.net', 'blob:'])
    expect(csp['object-src']).toEqual(["'none'"])
    expect(csp['base-uri']).toEqual(["'none'"])
    expect(csp['frame-ancestors']).toEqual(["'none'"])
    expect(csp['form-action']).toEqual(["'none'"])
  })

  it('sets the usual security headers, allows the microphone for this site only, and no cookies', () => {
    expect(all['x-content-type-options']).toBe('nosniff')
    expect(all['strict-transport-security']).toContain('max-age=')
    expect(all['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(all['permissions-policy']).toContain('microphone=(self)')
    expect(all['permissions-policy']).toContain('camera=()')
    expect(Object.keys(all)).not.toContain('set-cookie')
  })

  it('does not enable cross-origin isolation in this prototype', () => {
    expect(Object.keys(all)).not.toContain('cross-origin-opener-policy')
    expect(Object.keys(all)).not.toContain('cross-origin-embedder-policy')
  })
})

describe('sample notebooks', () => {
  it('has a file for every entry of the menu, and the other way round', async () => {
    const { readdirSync } = await import('node:fs')
    expect(samples.map((sample) => sample.file).sort()).toEqual(readdirSync('notebooks').filter((name) => name.endsWith('.ipynb')).sort())
    for (const sample of samples) expect(existsSync(`notebooks/${sample.file}`)).toBe(true)
  })
})
