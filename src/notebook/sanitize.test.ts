// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown.ts'
import { cleanBase64, escapeHtml, sanitizeHtml } from './sanitize.ts'

function dom(html: string): HTMLElement {
  const box = document.createElement('div')
  box.innerHTML = html
  return box
}

/** Everything that could run code or leave the page, looked for in sanitized markup. */
function dangers(html: string): string[] {
  const box = dom(html)
  const found: string[] = []
  for (const node of box.querySelectorAll('*')) {
    const tag = node.tagName.toLowerCase()
    if (['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'style', 'link', 'meta', 'base', 'frame'].includes(tag)) {
      found.push(`<${tag}>`)
    }
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith('on')) found.push(`${tag}[${attr.name}]`)
      if (/^\s*(javascript|vbscript):/i.test(attr.value)) found.push(`${tag}[${attr.name}=${attr.value}]`)
      if (attr.name === 'srcdoc' || attr.name === 'formaction' || attr.name === 'action') found.push(`${tag}[${attr.name}]`)
    }
  }
  return found
}

const ATTACKS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)><script>alert(1)</script><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<iframe src="https://evil.example"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="x"></object><embed src="x">',
  '<form action="https://evil.example"><input name="q"><button formaction="javascript:alert(1)">go</button></form>',
  '<style>@import url(https://evil.example/x.css); body{display:none}</style>',
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<base href="https://evil.example/">',
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;"></mglyph></table></mtext></math>',
  '<details open ontoggle=alert(1)>x</details>',
  '<video><source onerror=alert(1)></video>',
  '<div onclick="alert(1)" onmouseover="alert(1)">x</div>',
  '<svg><use href="https://evil.example/x.svg#a"></use><image href="https://evil.example/track.png"></image></svg>',
  '<svg><foreignObject><iframe src="x"></iframe></foreignObject></svg>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
]

describe('sanitizeHtml', () => {
  it.each(ATTACKS)('removes active content: %s', (attack) => {
    expect(dangers(sanitizeHtml(attack))).toEqual([])
  })

  it('removes them when they are nested and combined', () => {
    expect(dangers(sanitizeHtml(ATTACKS.join('\n')))).toEqual([])
    expect(dangers(sanitizeHtml(`<div><p>${ATTACKS.join('</p><p>')}</p></div>`))).toEqual([])
  })

  it('keeps ordinary formatting, tables, images and players', () => {
    const html = sanitizeHtml(
      '<h2>Title</h2><p>Some <b>bold</b>, <em>em</em>, <code>code</code>, <sub>s</sub></p><ul><li>a</li></ul>' +
        '<table class="dataframe"><thead><tr><th>x</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>' +
        '<img src="https://example.org/a.png" alt="figure" width="100">' +
        '<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">' +
        '<audio controls src="data:audio/wav;base64,UklGRg=="></audio>' +
        '<pre>  keep   spaces </pre><span style="color: red">red</span>',
    )
    const box = dom(html)
    expect(box.querySelector('h2')?.textContent).toBe('Title')
    expect(box.querySelectorAll('b, em, code, sub, li, th, td').length).toBe(7)
    expect(box.querySelector('table')?.className).toBe('dataframe')
    expect(box.querySelectorAll('img')[0].getAttribute('src')).toBe('https://example.org/a.png')
    expect(box.querySelectorAll('img')[1].getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(box.querySelector('audio')?.getAttribute('src')).toBe('data:audio/wav;base64,UklGRg==')
    expect(box.querySelector('audio')?.hasAttribute('controls')).toBe(true)
    expect(box.querySelector('pre')?.textContent).toBe('  keep   spaces ')
    expect(box.querySelector('span')?.getAttribute('style')).toContain('color')
  })

  it('keeps an SVG plot', () => {
    const html = sanitizeHtml(
      '<svg viewBox="0 0 100 50" width="100" height="50" role="img" aria-label="plot"><g fill="#2553c7" fill-opacity="0.7">' +
        '<circle cx="10" cy="10" r="2"/><rect x="1" y="2" width="3" height="4"/><line x1="0" x2="5" y1="0" y2="5" stroke="#000"/>' +
        '<polyline points="0,0 5,5" fill="none"/><text x="5" y="5" font-size="12" text-anchor="middle">label</text></g></svg>',
    )
    const box = dom(html)
    expect(box.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 100 50')
    expect(box.querySelectorAll('circle, rect, line, polyline, text').length).toBe(5)
    expect(box.querySelector('g')?.getAttribute('fill-opacity')).toBe('0.7')
    expect(box.querySelector('text')?.textContent).toBe('label')
  })

  it('makes links open in a new tab without a referrer', () => {
    const link = dom(sanitizeHtml('<a href="https://example.org/page" target="_self" rel="opener">x</a>')).querySelector('a')!
    expect(link.getAttribute('href')).toBe('https://example.org/page')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow')
  })

  it('removes autoplay and styles that load something or cover the page', () => {
    expect(dom(sanitizeHtml('<audio autoplay controls src="https://example.org/a.mp3"></audio>')).querySelector('audio')?.hasAttribute('autoplay')).toBe(false)
    for (const style of ['background: url(https://evil.example/track)', 'position: fixed; inset: 0', 'position:sticky', 'width: expression(alert(1))']) {
      expect(dom(sanitizeHtml(`<div style="${style}">x</div>`)).querySelector('div')?.hasAttribute('style')).toBe(false)
    }
    expect(dom(sanitizeHtml('<div style="position: absolute; top: 0">x</div>')).querySelector('div')?.getAttribute('style')).toContain('absolute')
  })

  it('prefixes ids and names so that they cannot shadow properties of the document', () => {
    const box = dom(sanitizeHtml('<img name="cookie" src="https://example.org/a.png"><p id="getElementById">x</p>'))
    expect(box.querySelector('img')?.getAttribute('name')).toBe('user-content-cookie')
    expect(box.querySelector('p')?.id).toBe('user-content-getElementById')
  })

  it('removes srcset, data attributes and external references inside SVG', () => {
    const box = dom(
      sanitizeHtml(
        '<img srcset="https://evil.example/a.png 2x" src="https://example.org/a.png" data-x="1">' +
          '<svg><use href="https://evil.example/x.svg#a"></use><use href="#local"></use><image href="https://evil.example/t.png"></image></svg>',
      ),
    )
    expect(box.querySelector('img')?.hasAttribute('srcset')).toBe(false)
    expect(box.querySelector('img')?.hasAttribute('data-x')).toBe(false)
    const hrefs = Array.from(box.querySelectorAll('svg *'), (node) => node.getAttribute('href'))
    expect(hrefs.filter((href) => href && !href.startsWith('#'))).toEqual([])
  })
})

describe('renderMarkdown', () => {
  it('renders Markdown and sanitizes the result', () => {
    const html = renderMarkdown('# Title\n\nSome *text* with `code`.\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[link](javascript:alert(1))')
    const box = dom(html)
    expect(box.querySelector('h1')?.textContent).toBe('Title')
    expect(box.querySelectorAll('li').length).toBe(2)
    expect(box.querySelectorAll('td').length).toBe(2)
    expect(box.querySelector('code')?.textContent).toBe('code')
    expect(dangers(html)).toEqual([])
    expect(box.querySelector('script')).toBeNull()
  })

  it('renders formulas with KaTeX and leaves prices alone', () => {
    const box = dom(renderMarkdown('Inline $a^2 + b^2$ and $5 or $6.\n\n$$\\frac{1}{\\sqrt{d_k}}$$\n\nIn a paragraph: $$x_t$$ too. Code `$not math$` stays.'))
    expect(box.querySelectorAll('.katex').length).toBe(3)
    expect(box.querySelectorAll('.math-block .katex-display').length).toBe(1)
    expect(box.querySelector('annotation')?.textContent).toBe('a^2 + b^2')
    expect(box.textContent).toContain('$5 or $6.')
    expect(box.querySelector('code')?.textContent).toBe('$not math$')
    expect(box.querySelector('.katex [style]')).not.toBeNull()
  })

  it('does not let a formula inject markup', () => {
    const html = renderMarkdown('$\\href{javascript:alert(1)}{x}$ and $\\htmlData{onclick=alert(1)}{y}$ and $<img src=x onerror=alert(1)>$')
    expect(dangers(html)).toEqual([])
  })

  it('renders the Markdown of the sample notebooks without leftover dollar signs', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const files = readdirSync('notebooks').filter((name) => name.endsWith('.ipynb'))
    expect(files).toHaveLength(6)
    for (const file of files) {
      const nb = JSON.parse(readFileSync(`notebooks/${file}`, 'utf8')) as { cells: Array<{ cell_type: string; source: string[] }> }
      for (const cell of nb.cells.filter((c) => c.cell_type === 'markdown')) {
        const box = dom(renderMarkdown(cell.source.join('')))
        expect(box.querySelector('.katex-error'), `${file}: a formula failed to parse`).toBeNull()
        // Text outside formulas and code must not contain "$": that would be a formula that was not recognised.
        for (const node of box.querySelectorAll('.katex, code')) node.remove()
        expect(box.textContent, `${file}: ${cell.source.join('').slice(0, 60)}`).not.toContain('$')
      }
    }
  })
})

describe('helpers', () => {
  it('escapes text', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;')
  })

  it('accepts only base64 for data addresses', () => {
    expect(cleanBase64('iVBO\nRw0K\n')).toBe('iVBORw0K')
    expect(cleanBase64('QQ==')).toBe('QQ==')
    expect(cleanBase64('"><script>alert(1)</script>')).toBeNull()
    expect(cleanBase64('')).toBeNull()
    expect(cleanBase64('abc;def')).toBeNull()
  })
})
