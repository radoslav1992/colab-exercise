// Draws the doodles of the site: `node scripts/doodles.mjs` writes src/doodles/*.svg, which are
// committed. Nothing is drawn in the browser. The drawings come from simple geometry that
// rough.js (https://roughjs.com, MIT) wobbles like a hand would; every doodle has fixed seeds, so
// running the script again gives the same files.
//
// One pen everywhere: 2 px, round caps, ink = currentColor. Accents are classes that the style
// sheet colours (src/base.css), so the doodles follow the light and the dark theme:
//   dy / fy   highlighter yellow (stroke / flat fill)       db / fb   ballpoint blue
//   dr / fr   the teacher's red pen                         dg / fg   green, "check passed"
//   fk        filled with ink                               dt        handwriting (Caveat)
// A doodle is drawn at the size it is shown, so one unit is one CSS pixel.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import rough from 'roughjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** DOODLES_OUT=folder writes everything there instead (the tests compare it with the committed files). */
const out = process.env.DOODLES_OUT ?? join(root, 'src', 'doodles')
const gen = rough.generator()

/** A small deterministic random generator (mulberry32) for the places where the script itself scatters points. */
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const round = (n) => String(Math.round(n * 10) / 10)

/** rough.js writes "M1 2 C3 4, 5 6, 7 8"; the same path without the spaces it does not need. */
function compact(d) {
  return d
    .replace(/,/g, '')
    .replace(/\s*([MCLQZ])\s*/g, '$1')
    .replace(/ -/g, '-')
    .trim()
}

class Doodle {
  constructor(name, width, height, seed, options = {}) {
    this.name = name
    this.width = width
    this.height = height
    this.seed = seed * 1000
    this.parts = []
    this.roughness = options.roughness ?? 1
    this.pen = options.pen ?? 2
    /** Stretched ornaments (underline, swash) keep their pen width whatever their size. */
    this.stretch = options.stretch === true
  }

  options(o = {}) {
    this.seed += 1
    return {
      seed: this.seed,
      roughness: o.roughness ?? this.roughness,
      bowing: o.bowing ?? 1,
      disableMultiStroke: o.double !== true,
      preserveVertices: true,
      fixedDecimalPlaceDigits: 1,
      maxRandomnessOffset: o.wobble ?? 1.6,
      curveStepCount: 7,
    }
  }

  emit(drawable, o = {}) {
    for (const set of drawable.sets) {
      if (set.type !== 'path') continue
      const attributes = [`d="${compact(gen.opsToPath(set, 1))}"`]
      if (o.cls) attributes.push(`class="${o.cls}"`)
      if (o.width && o.width !== this.pen) attributes.push(`stroke-width="${o.width}"`)
      if (o.dash) attributes.push(`stroke-dasharray="${o.dash}"`)
      if (o.shift) attributes.push(`transform="translate(${o.shift[0]} ${o.shift[1]})"`)
      this.parts.push(`<path ${attributes.join(' ')}/>`)
    }
    return this
  }

  line(x1, y1, x2, y2, o = {}) {
    return this.emit(gen.line(x1, y1, x2, y2, this.options(o)), o)
  }

  /** A smooth line through the points. */
  curve(points, o = {}) {
    return this.emit(gen.curve(points, this.options(o)), o)
  }

  /** Straight lines from point to point; `close` joins the last to the first. */
  poly(points, o = {}) {
    if (o.close !== false) return this.emit(gen.polygon(points, this.options(o)), o)
    return this.emit(gen.linearPath(points, this.options(o)), o)
  }

  rect(x, y, w, h, o = {}) {
    return this.emit(gen.rectangle(x, y, w, h, this.options(o)), o)
  }

  ellipse(cx, cy, w, h, o = {}) {
    return this.emit(gen.ellipse(cx, cy, w, h, this.options({ ...o, roughness: o.roughness ?? this.roughness * 0.8 })), o)
  }

  /** Part of a circle, from one angle to another (radians, clockwise from the right). */
  arc(cx, cy, r, from, to, o = {}) {
    const points = []
    const steps = Math.max(4, Math.round((Math.abs(to - from) * r) / 9))
    for (let i = 0; i <= steps; i++) {
      const a = from + ((to - from) * i) / steps
      points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
    return this.curve(points, o)
  }

  /** An SVG path as it is written (for shapes that need exact corners), wobbled a little. */
  path(d, o = {}) {
    return this.emit(gen.path(d, this.options(o)), o)
  }

  /** A flat patch of colour behind a shape, a little off-register like a quick marker fill. */
  fill(points, cls = 'fy', shift = [2.5, 2.5]) {
    const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round(x + shift[0])} ${round(y + shift[1])}`).join('') + 'Z'
    this.parts.push(`<path d="${d}" class="${cls}"/>`)
    return this
  }

  fillRect(x, y, w, h, cls = 'fy', shift = [2.5, 2.5]) {
    return this.fill(
      [
        [x, y + 1],
        [x + w, y],
        [x + w - 1, y + h],
        [x + 1, y + h - 1],
      ],
      cls,
      shift,
    )
  }

  dot(x, y, r = 1.7, cls = 'fk') {
    this.parts.push(`<circle cx="${round(x)}" cy="${round(y)}" r="${r}" class="${cls}"/>`)
    return this
  }

  /** Many dots at once, as one path: each dot is a stroke with no length and a round end. */
  dots(points, size = 3) {
    const d = points.map(([x, y]) => `M${round(x)} ${round(y)}h.1`).join('')
    this.parts.push(`<path d="${d}" stroke-width="${size}"/>`)
    return this
  }

  /** Handwriting. The text is decoration: everything it says is also said in the page next to the doodle. */
  text(x, y, value, o = {}) {
    const attributes = [`x="${x}"`, `y="${y}"`, `font-size="${o.size ?? 22}"`, `class="${['dt', o.cls].filter(Boolean).join(' ')}"`]
    if (o.anchor) attributes.push(`text-anchor="${o.anchor}"`)
    if (o.rotate) attributes.push(`transform="rotate(${o.rotate} ${x} ${y})"`)
    this.parts.push(`<text ${attributes.join(' ')}>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`)
    return this
  }

  /** A line through the points that ends in an arrow head. */
  arrow(points, o = {}) {
    this.curve(points, o)
    const [x2, y2] = points[points.length - 1]
    const [x1, y1] = points[points.length - 2]
    const angle = Math.atan2(y2 - y1, x2 - x1)
    const size = o.head ?? 8
    for (const turn of [2.55, -2.55]) {
      this.line(x2, y2, x2 + size * Math.cos(angle + turn), y2 + size * Math.sin(angle + turn), { ...o, roughness: 0.5 })
    }
    return this
  }

  svg() {
    const stretch = this.stretch ? ' preserveAspectRatio="none"' : ''
    const head = `<svg xmlns="http://www.w3.org/2000/svg" class="doodle doodle-${this.name}" viewBox="0 0 ${this.width} ${this.height}" width="${this.width}" height="${this.height}"${stretch} fill="none" stroke="currentColor" stroke-width="${this.pen}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">`
    return `${head}${this.parts.join('')}</svg>\n`
  }
}

const doodles = []
function draw(name, width, height, seed, options, body) {
  if (typeof options === 'function') [options, body] = [{}, options]
  const d = new Doodle(name, width, height, seed, options)
  body(d)
  doodles.push(d)
}

// --- The five topics --------------------------------------------------------------------------------

// Speech to text: a waveform turns into written words.
draw('speech-to-text', 240, 120, 11, (d) => {
  const heights = [5, 12, 22, 15, 30, 19, 9, 25, 34, 17, 8, 21, 12, 5]
  heights.forEach((h, i) => d.line(14 + i * 6.6, 58 - h, 14 + i * 6.6, 58 + h, { cls: 'db', roughness: 0.6, width: 2.4 }))
  d.arrow(
    [
      [110, 60],
      [121, 57],
      [133, 59],
    ],
    { roughness: 0.6 },
  )
  d.line(146, 51, 205, 49, { cls: 'dy', width: 15, roughness: 0.8 })
  d.text(146, 56, 'ask not', { size: 25 })
  d.text(146, 88, 'what your…', { size: 25 })
  d.line(144, 64, 228, 62, { width: 1.2, roughness: 0.5 })
  d.line(144, 96, 230, 95, { width: 1.2, roughness: 0.5 })
})

// Text to speech: a speech bubble turns into sound waves from a speaker.
draw('text-to-speech', 240, 120, 23, (d) => {
  const bubble = [
    [14, 22],
    [100, 20],
    [102, 74],
    [50, 76],
    [30, 94],
    [32, 76],
    [13, 75],
  ]
  d.fill(bubble, 'fy', [3, 3])
  d.poly(bubble, { double: true, roughness: 0.9 })
  d.text(57, 57, 'Hello!', { size: 27, anchor: 'middle' })
  d.arrow(
    [
      [112, 50],
      [123, 47],
      [135, 50],
    ],
    { roughness: 0.6 },
  )
  d.poly(
    [
      [146, 40],
      [158, 40],
      [178, 24],
      [179, 80],
      [158, 64],
      [146, 64],
    ],
    { double: true, roughness: 0.8 },
  )
  d.line(158, 41, 158, 63, { roughness: 0.5 })
  for (const [r, width] of [
    [13, 2.2],
    [25, 2.2],
    [37, 2.2],
  ]) {
    d.arc(182, 52, r, -0.85, 0.85, { cls: 'db', width, roughness: 0.6 })
  }
})

// Language model: a row of token boxes, and the probabilities of the next token as bars.
draw('language-model', 240, 132, 31, (d) => {
  const tokens = [
    ['The', 10, 40],
    ['cat', 56, 40],
    ['sat', 102, 40],
  ]
  for (const [word, x, w] of tokens) {
    d.rect(x, 10, w, 28, { roughness: 0.8 })
    d.text(x + w / 2, 30, word, { size: 22, anchor: 'middle' })
  }
  d.fillRect(148, 10, 34, 28, 'fy', [2.5, 2.5])
  d.rect(148, 10, 34, 28, { roughness: 0.8, dash: '5 5' })
  d.text(165, 31, '?', { size: 26, anchor: 'middle' })
  d.arrow(
    [
      [190, 26],
      [212, 36],
      [206, 62],
      [190, 72],
    ],
    { roughness: 0.5 },
  )
  const bars = [
    ['on', 112],
    ['down', 62],
    ['up', 30],
  ]
  bars.forEach(([word, w], i) => {
    const y = 62 + i * 23
    d.text(58, y + 12, word, { size: 21, anchor: 'end' })
    if (i === 0) d.fillRect(66, y, w, 13, 'fb', [0, 0])
    d.rect(66, y, w, 13, { roughness: 0.7, cls: i === 0 ? '' : '' })
  })
  d.line(66, 56, 66, 128, { roughness: 0.5, width: 1.4 })
})

// Attention: a sentence, and arcs of different weight from one word to the others.
draw('attention', 240, 120, 47, (d) => {
  const words = [
    ['the', 22],
    ['cat', 64],
    ['sat', 106],
    ['on', 142],
    ['the', 176],
    ['mat', 216],
  ]
  d.line(92, 97, 121, 96, { cls: 'dy', width: 15, roughness: 0.8 })
  for (const [word, x] of words) d.text(x, 104, word, { size: 25, anchor: 'middle' })
  const arcs = [
    [106, 64, 4.2],
    [106, 216, 2.6],
    [106, 22, 1.3],
    [106, 142, 1.3],
  ]
  for (const [from, to, width] of arcs) {
    const middle = (from + to) / 2
    const reach = Math.abs(to - from) / 2
    const height = 14 + reach * 0.62
    const points = []
    for (let i = 0; i <= 8; i++) {
      const a = (Math.PI * i) / 8
      points.push([middle + (from < to ? -1 : 1) * reach * Math.cos(a), 80 - height * Math.sin(a)])
    }
    d.curve(points, { cls: 'db', width, roughness: 0.35 })
    d.dot(to, 81, width > 2 ? 2.8 : 2.1, 'fb')
  }
})

// Diffusion: a few frames from noise to a clear shape.
draw('diffusion', 240, 96, 59, (d) => {
  const next = random(5)
  const size = 46
  const xs = [6, 67, 128, 189]
  const star = []
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    const r = i % 2 === 0 ? 18 : 7.8
    star.push([r * Math.cos(a), r * Math.sin(a) + 1])
  }
  // Points along the outline of the star, and a random start for each of them.
  const targets = []
  for (let i = 0; i < 30; i++) {
    const a = star[Math.floor(i / 3)]
    const b = star[(Math.floor(i / 3) + 1) % 10]
    const t = (i % 3) / 3
    targets.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
  }
  const starts = targets.map(() => [(next() - 0.5) * 36, (next() - 0.5) * 36])
  const frames = [
    [0, 0],
    [0.62, 2.2],
    [1, 0.7],
  ]
  xs.forEach((x, k) => {
    const y = 22
    const cx = x + size / 2
    const cy = y + size / 2
    if (k === 3) d.fill(star.map(([px, py]) => [cx + px, cy + py]), 'fy', [2, 2])
    d.rect(x, y, size, size, { roughness: 0.7, width: 1.5 })
    if (k < 3) {
      const [t, noise] = frames[k]
      d.dots(
        targets.map((target, i) => [
          cx + starts[i][0] + (target[0] - starts[i][0]) * t + (next() - 0.5) * noise * 2,
          cy + starts[i][1] + (target[1] - starts[i][1]) * t + (next() - 0.5) * noise * 2,
        ]),
      )
      d.arrow(
        [
          [x + size + 4, cy],
          [x + size + 12, cy],
        ],
        { roughness: 0.3, head: 4.5, width: 1.5 },
      )
    } else {
      d.poly(star.map(([px, py]) => [cx + px, cy + py]), { roughness: 0.6 })
    }
  })
  d.text(xs[0] + size / 2, 90, 'noise', { size: 20, anchor: 'middle' })
  d.text(xs[3] + size / 2, 90, 'a star', { size: 20, anchor: 'middle' })
})

// --- How it works for a teacher ---------------------------------------------------------------------

// A notebook file.
draw('file', 120, 110, 61, (d) => {
  const page = [
    [28, 8],
    [70, 8],
    [90, 28],
    [90, 102],
    [28, 102],
  ]
  d.fill(page, 'fy', [3, 3])
  d.poly(page, { double: true, roughness: 0.8 })
  d.poly(
    [
      [70, 8],
      [70, 28],
      [90, 28],
    ],
    { close: false, roughness: 0.6 },
  )
  d.line(38, 40, 76, 40, { roughness: 0.5, width: 1.6 })
  d.line(38, 50, 66, 50, { roughness: 0.5, width: 1.6 })
  d.rect(38, 60, 43, 16, { roughness: 0.6, cls: 'db', width: 1.6 })
  d.poly(
    [
      [43, 64],
      [43, 72],
      [50, 68],
    ],
    { roughness: 0.3, cls: 'db', width: 1.6 },
  )
  d.text(59, 96, '.ipynb', { size: 20, anchor: 'middle' })
  d.line(104, 14, 104, 26, { roughness: 0.4, width: 1.6 })
  d.line(98, 20, 110, 20, { roughness: 0.4, width: 1.6 })
  d.line(12, 78, 12, 86, { roughness: 0.4, width: 1.6 })
  d.line(8, 82, 16, 82, { roughness: 0.4, width: 1.6 })
})

// A join code on a ticket.
draw('join-code', 120, 110, 67, (d) => {
  const ticket = [
    [8, 44],
    [110, 34],
    [114, 72],
    [12, 82],
  ]
  d.fill(ticket, 'fy', [3, 3])
  d.poly(ticket, { roughness: 0.8, dash: '6 6' })
  d.text(61, 66, 'K7QM-2XPA', { size: 23, anchor: 'middle', rotate: -5.5 })
  for (const [x1, y1, x2, y2] of [
    [48, 24, 44, 12],
    [62, 22, 63, 9],
    [76, 21, 82, 10],
  ]) {
    d.line(x1, y1, x2, y2, { roughness: 0.4, cls: 'db', width: 1.8 })
  }
})

// A laptop with the notebook open.
draw('laptop', 120, 110, 71, (d) => {
  d.fillRect(22, 18, 76, 54, 'fy', [3, 3])
  d.rect(22, 18, 76, 54, { double: true, roughness: 0.8 })
  d.poly(
    [
      [16, 76],
      [104, 76],
      [114, 92],
      [6, 92],
    ],
    { double: true, roughness: 0.8 },
  )
  d.line(48, 86, 72, 86, { roughness: 0.4, width: 1.6 })
  d.line(31, 29, 62, 29, { roughness: 0.4, cls: 'db', width: 1.8 })
  d.line(31, 38, 78, 38, { roughness: 0.4, cls: 'db', width: 1.8 })
  d.line(31, 47, 54, 47, { roughness: 0.4, cls: 'db', width: 1.8 })
  d.poly(
    [
      [31, 59],
      [36, 64],
      [45, 54],
    ],
    { close: false, roughness: 0.4, cls: 'dg', width: 2.4 },
  )
  d.line(52, 60, 88, 60, { roughness: 0.4, cls: 'dg', width: 2.4 })
})

// A paper plane: handing in.
draw('plane', 120, 110, 73, (d) => {
  const a = [22, 46]
  const b = [110, 16]
  const c = [70, 90]
  const fold = [56, 60]
  d.fill([a, b, fold], 'fy', [2, 3])
  d.poly([a, b, c, fold], { double: true, roughness: 0.7 })
  d.line(fold[0], fold[1], b[0], b[1], { roughness: 0.5 })
  d.line(fold[0], fold[1], 58, 80, { roughness: 0.4 })
  d.line(58, 80, c[0] - 4, c[1] - 12, { roughness: 0.4 })
  d.curve(
    [
      [6, 98],
      [18, 86],
      [30, 90],
      [28, 100],
      [18, 98],
      [24, 82],
      [42, 72],
    ],
    { roughness: 0.4, dash: '3 6', width: 1.8 },
  )
})

// The grade, in red pen.
draw('grade', 120, 110, 79, (d) => {
  d.text(52, 62, '8.5/10', { size: 34, anchor: 'middle', rotate: -7, cls: 'tr' })
  d.ellipse(53, 50, 92, 50, { cls: 'dr', double: true, roughness: 1.6 })
  d.poly(
    [
      [72, 88],
      [82, 100],
      [108, 68],
    ],
    { close: false, cls: 'dr', roughness: 0.6, width: 3 },
  )
})

// --- Ornaments ---------------------------------------------------------------------------------------

draw('squiggle', 200, 12, 83, { stretch: true }, (d) => {
  const points = []
  for (let i = 0; i <= 12; i++) points.push([4 + i * 16, i % 2 === 0 ? 8 : 4])
  d.curve(points, { roughness: 0.5 })
})

draw('underline', 200, 12, 85, { stretch: true }, (d) => {
  d.curve(
    [
      [3, 7],
      [60, 4],
      [130, 5],
      [197, 3],
    ],
    { roughness: 0.6 },
  )
  d.curve(
    [
      [22, 10],
      [90, 8],
      [176, 8],
    ],
    { roughness: 0.6 },
  )
})

// The highlighter: three passes of a broad marker.
draw('swash', 200, 40, 89, { stretch: true, pen: 15 }, (d) => {
  d.line(10, 12, 190, 10, { cls: 'dy', roughness: 1.2 })
  d.line(8, 21, 193, 20, { cls: 'dy', roughness: 1.2 })
  d.line(13, 30, 187, 30, { cls: 'dy', roughness: 1.2 })
})

// The arrows of the hero. Each starts at a handwritten note and ends at what the note is about
// (the places are set in src/landing.css): 1 comes down the left margin to the code cell, 2 loops
// in from the right to the output, 3 comes up from below to "Check passed".
draw('arrow-1', 64, 190, 97, (d) => {
  d.arrow(
    [
      [56, 8],
      [30, 16],
      [13, 52],
      [9, 112],
      [20, 156],
      [50, 176],
    ],
    { roughness: 0.4, head: 10 },
  )
})

draw('arrow-2', 80, 64, 101, (d) => {
  d.arrow(
    [
      [66, 6],
      [68, 26],
      [52, 38],
      [40, 30],
      [48, 20],
      [58, 30],
      [44, 48],
      [8, 50],
    ],
    { roughness: 0.3, head: 10 },
  )
})

draw('arrow-3', 70, 64, 103, (d) => {
  d.arrow(
    [
      [62, 54],
      [40, 52],
      [22, 36],
      [14, 8],
    ],
    { roughness: 0.4, head: 10 },
  )
})

// A short arrow that points up, for the notes under the mock on narrow screens.
draw('arrow-short', 30, 30, 105, (d) => {
  d.arrow(
    [
      [8, 26],
      [10, 15],
      [18, 6],
    ],
    { roughness: 0.4, head: 7 },
  )
})

draw('sparkle', 40, 40, 107, (d) => {
  const star = 'M20 4 C21 14 26 19 36 20 C26 21 21 26 20 36 C19 26 14 21 4 20 C14 19 19 14 20 4 Z'
  d.parts.push(`<path d="M22 6C23 16 28 21 38 22C28 23 23 28 22 38C21 28 16 23 6 22C16 21 21 16 22 6Z" class="fy"/>`)
  d.path(star, { roughness: 0.5 })
})

draw('circle', 120, 56, 109, { stretch: true }, (d) => {
  d.ellipse(60, 28, 108, 44, { double: true, roughness: 1.5 })
})

draw('tick', 32, 28, 113, (d) => {
  d.poly(
    [
      [5, 15],
      [12, 23],
      [27, 5],
    ],
    { close: false, roughness: 0.5, width: 3 },
  )
})

// The brand mark: a cell you can run, coloured in with the highlighter.
draw('mark', 32, 32, 127, { pen: 2.2 }, (d) => {
  d.parts.push('<path d="M8.5 6.5L27.5 5.5Q29.5 5.5 29.5 8L29 27Q29 29 27 29L8 29.5Q6 29.5 6 27.5L6.5 8.5Q6.5 6.5 8.5 6.5Z" class="fy"/>')
  d.path('M7 4 L24 3.5 Q27 3.5 27 6.5 L26.5 24 Q26.5 27 23.5 27 L6.5 27.5 Q3.5 27.5 3.5 24.5 L4 7 Q4 4 7 4 Z', { roughness: 0.25 })
  d.parts.push('<path d="M12 10.2L12 20.8L20.6 15.4Z" class="fk"/>')
})

// --- Moments in the app -----------------------------------------------------------------------------

// No courses yet: an open notebook with nothing in it, and a pencil.
draw('no-courses', 200, 140, 131, (d) => {
  const right = [
    [100, 34],
    [130, 26],
    [168, 30],
    [170, 100],
    [132, 96],
    [100, 106],
  ]
  d.fill(right, 'fy', [3, 3])
  d.path('M100 36 C86 26 56 24 30 30 L30 100 C56 94 86 96 100 106', { double: true, roughness: 0.6 })
  d.path('M100 36 C114 26 144 24 170 30 L170 100 C144 94 114 96 100 106', { double: true, roughness: 0.6 })
  d.line(100, 37, 100, 105, { roughness: 0.5 })
  d.path('M30 100 L31 108 C56 102 86 104 100 114 C114 104 144 102 169 108 L170 100', { roughness: 0.5, width: 1.6 })
  d.line(44, 46, 86, 44, { roughness: 0.5, width: 1.3, dash: '2 6' })
  d.line(44, 60, 86, 58, { roughness: 0.5, width: 1.3, dash: '2 6' })
  d.line(44, 74, 86, 72, { roughness: 0.5, width: 1.3, dash: '2 6' })
  // The pencil
  d.poly(
    [
      [140, 122],
      [178, 76],
      [186, 82],
      [148, 128],
    ],
    { roughness: 0.5 },
  )
  d.poly(
    [
      [140, 122],
      [136, 134],
      [148, 128],
    ],
    { close: false, roughness: 0.4 },
  )
  d.line(173, 82, 181, 88, { roughness: 0.3, cls: 'dr', width: 2.4 })
  d.path('M20 4 C21 14 26 19 36 20 C26 21 21 26 20 36 C19 26 14 21 4 20 C14 19 19 14 20 4 Z', { roughness: 0.4, shift: [2, -2], width: 1.6 })
})

// No assignments yet: a clipboard with room for the first one.
draw('no-assignments', 200, 140, 137, (d) => {
  d.fillRect(66, 26, 70, 100, 'fy', [3, 3])
  d.rect(58, 16, 86, 116, { double: true, roughness: 0.8 })
  d.rect(66, 26, 70, 98, { roughness: 0.6, width: 1.5 })
  d.rect(84, 8, 34, 18, { roughness: 0.6 })
  d.parts.push('<path d="M85 9L117 9L117 25L85 25Z" class="fp"/>')
  d.rect(84, 8, 34, 18, { roughness: 0.6 })
  d.rect(82, 56, 38, 38, { roughness: 0.7, cls: 'db', dash: '5 6', width: 1.8 })
  d.line(101, 66, 101, 84, { roughness: 0.4, cls: 'db' })
  d.line(92, 75, 110, 75, { roughness: 0.4, cls: 'db' })
  d.line(78, 108, 124, 107, { roughness: 0.5, width: 1.3, dash: '2 6' })
  d.line(160, 40, 160, 52, { roughness: 0.4, width: 1.6 })
  d.line(154, 46, 166, 46, { roughness: 0.4, width: 1.6 })
  d.line(36, 96, 36, 104, { roughness: 0.4, width: 1.6 })
  d.line(32, 100, 40, 100, { roughness: 0.4, width: 1.6 })
})

// Everything handed in: a pile of papers with a tick, and a hot drink.
draw('all-done', 200, 140, 139, (d) => {
  d.poly(
    [
      [86, 44],
      [158, 36],
      [166, 112],
      [94, 120],
    ],
    { roughness: 0.7, width: 1.6 },
  )
  d.parts.push('<path d="M80 38L152 34L156 110L84 114Z" class="fp"/>')
  d.fillRect(80, 36, 74, 76, 'fy', [3, 3])
  d.poly(
    [
      [80, 38],
      [152, 34],
      [156, 110],
      [84, 114],
    ],
    { double: true, roughness: 0.8 },
  )
  d.poly(
    [
      [98, 76],
      [112, 92],
      [142, 54],
    ],
    { close: false, roughness: 0.6, cls: 'dg', width: 4 },
  )
  // The mug
  d.parts.push('<path d="M24 86L60 86L57 124L27 124Z" class="fp"/>')
  d.poly(
    [
      [24, 86],
      [60, 86],
      [57, 124],
      [27, 124],
    ],
    { double: true, roughness: 0.7 },
  )
  d.arc(59, 102, 10, -1.2, 1.3, { roughness: 0.4 })
  d.curve(
    [
      [34, 76],
      [30, 68],
      [37, 62],
      [33, 54],
    ],
    { roughness: 0.4, width: 1.6 },
  )
  d.curve(
    [
      [48, 76],
      [44, 68],
      [51, 62],
      [47, 54],
    ],
    { roughness: 0.4, width: 1.6 },
  )
})

// Page not found: a magnifying glass over an empty page.
draw('not-found', 200, 140, 149, (d) => {
  const page = [
    [44, 14],
    [102, 14],
    [124, 36],
    [124, 126],
    [44, 126],
  ]
  d.fill(page, 'fy', [3, 3])
  d.poly(page, { double: true, roughness: 0.8 })
  d.poly(
    [
      [102, 14],
      [102, 36],
      [124, 36],
    ],
    { close: false, roughness: 0.6 },
  )
  d.line(56, 52, 96, 51, { roughness: 0.5, width: 1.3, dash: '2 6' })
  d.line(56, 66, 84, 65, { roughness: 0.5, width: 1.3, dash: '2 6' })
  d.parts.push('<circle cx="118" cy="86" r="25" class="fp"/>')
  d.ellipse(118, 86, 52, 52, { double: true, roughness: 0.9 })
  d.line(137, 105, 164, 131, { roughness: 0.5, width: 5 })
  d.text(118, 98, '?', { size: 40, anchor: 'middle', cls: 'tr' })
  d.text(170, 44, '404', { size: 26, anchor: 'middle', rotate: 8 })
})

mkdirSync(out, { recursive: true })
for (const file of readdirSync(out)) if (file.endsWith('.svg')) rmSync(join(out, file))
let total = 0
for (const d of doodles) {
  const svg = d.svg()
  total += svg.length
  writeFileSync(join(out, `${d.name}.svg`), svg)
}
// The icon of the site is the brand mark with its colours written in: an icon cannot follow the theme of the page.
const mark = doodles.find((d) => d.name === 'mark')
const icon = mark
  .svg()
  .replace(/ class="doodle doodle-mark"| aria-hidden="true"| focusable="false"| width="32" height="32"/g, '')
  .replace('stroke="currentColor"', 'stroke="#1c1d22"')
  .replace(/class="fy"/g, 'fill="#ffe45c" stroke="none"')
  .replace(/class="fk"/g, 'fill="#1c1d22" stroke="none"')
writeFileSync(process.env.DOODLES_OUT ? join(out, 'favicon.svg') : join(root, 'public', 'favicon.svg'), icon)

console.log(`${doodles.length} doodles, ${(total / 1000).toFixed(1)} kB, in ${process.env.DOODLES_OUT ?? 'src/doodles/'}`)
