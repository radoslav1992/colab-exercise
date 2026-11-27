/**
 * Notebooks are untrusted input: a file a student opens can contain any HTML in its Markdown cells
 * and in its stored outputs. Everything that becomes HTML on the page goes through `sanitizeHtml`
 * first: rendered Markdown, `text/html` and SVG outputs, and what `lab.html()` shows.
 *
 * What is removed: scripts and event handlers, `javascript:` addresses, frames, forms and form
 * controls, `<style>` sheets, `<base>`/`<meta>`/`<link>`, and autoplay. What stays: ordinary
 * formatting, tables, images, audio and video players, SVG and MathML (for plots and formulas).
 */
import DOMPurify, { type Config } from 'dompurify'

const CONFIG: Config = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  FORBID_TAGS: [
    'style',
    'form',
    'input',
    'button',
    'textarea',
    'select',
    'option',
    'optgroup',
    'fieldset',
    'label',
    'dialog',
    'frame',
    'frameset',
    'iframe',
    'object',
    'embed',
    'base',
    'link',
    'meta',
    'nav',
    'foreignObject',
  ],
  FORBID_ATTR: ['autoplay', 'action', 'formaction', 'contenteditable', 'tabindex', 'accesskey', 'srcset', 'ping'],
  // KaTeX writes these MathML attributes and its own <annotation>.
  ADD_TAGS: ['semantics', 'annotation'],
  ADD_ATTR: ['encoding', 'controls', 'loop', 'muted', 'preload'],
  // `id` and `name` values get a prefix so that they cannot shadow properties of `document`.
  SANITIZE_NAMED_PROPS: true,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: true,
}

let hooked = false

function installHooks(): void {
  if (hooked) return
  hooked = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return
    // Links open in a new tab and tell the other site nothing about this page.
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer nofollow')
    }
    // SVG links and `use` may only point inside the same drawing.
    for (const attr of ['xlink:href', 'href']) {
      if (node.namespaceURI === 'http://www.w3.org/2000/svg' && node.tagName !== 'a') {
        const value = node.getAttribute(attr)
        if (value && !value.startsWith('#') && !value.startsWith('data:image/')) node.removeAttribute(attr)
      }
    }
    // Inline styles may format but may not load anything or leave the output box.
    const style = node.getAttribute('style')
    if (style && /url\s*\(|expression\s*\(|@import|position\s*:\s*(fixed|sticky)/i.test(style)) {
      node.removeAttribute('style')
    }
  })
}

/** Returns HTML that is safe to assign to `innerHTML`. */
export function sanitizeHtml(html: string): string {
  installHooks()
  return DOMPurify.sanitize(html, CONFIG) as string
}

/** Text to HTML, for the places that build markup by hand. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** Base64 from a notebook file, checked before it goes into a `data:` address. Returns null if it is not base64. */
export function cleanBase64(value: string): string | null {
  const compact = value.replace(/\s+/g, '')
  return /^[A-Za-z0-9+/]*={0,2}$/.test(compact) && compact.length > 0 ? compact : null
}
