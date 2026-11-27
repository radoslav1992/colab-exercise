/**
 * Markdown cells: `marked` for Markdown, KaTeX for `$...$` and `$$...$$` formulas (the Jupyter
 * convention), then the sanitizer. The sanitizer always runs last.
 */
import katex from 'katex'
import { Marked, type TokenizerAndRendererExtension } from 'marked'
import { escapeHtml, sanitizeHtml } from './sanitize.ts'

function renderMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false, output: 'htmlAndMathml', trust: false })
  } catch {
    return `<code>${escapeHtml(tex)}</code>`
  }
}

const blockMath: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    const i = src.indexOf('$$')
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    const match = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src)
    if (!match) return undefined
    return { type: 'blockMath', raw: match[0], text: match[1].trim() }
  },
  renderer(token) {
    return `<div class="math-block">${renderMath(token.text as string, true)}</div>\n`
  },
}

const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    const i = src.indexOf('$')
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    // $$...$$ inside a paragraph, then $...$ with no space just inside the dollars (so "$5 and $6" stays text).
    const display = /^\$\$([^$]+?)\$\$/.exec(src)
    if (display) return { type: 'inlineMath', raw: display[0], text: display[1].trim(), display: true }
    const match = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src)
    if (!match) return undefined
    return { type: 'inlineMath', raw: match[0], text: match[1], display: false }
  },
  renderer(token) {
    return renderMath(token.text as string, Boolean(token.display))
  },
}

const marked = new Marked({ gfm: true, breaks: false, extensions: [blockMath, inlineMath] })

/** Markdown source to sanitized HTML. */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false })
  return sanitizeHtml(html)
}
