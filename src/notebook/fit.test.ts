import { describe, expect, it } from 'vitest'
import { describeDropped, fitNotebook } from './fit.ts'
import { parseNotebook, serializeNotebook } from './ipynb.ts'

const b64 = (n: number) => 'QUJD'.repeat(Math.ceil(n / 4)).slice(0, n)

function sample() {
  return parseNotebook(
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: 'markdown', id: 'm', metadata: {}, source: '# Title\n' + 'words '.repeat(2000) },
        {
          cell_type: 'code',
          id: 'a',
          metadata: {},
          execution_count: 1,
          source: 'lab.show(picture)',
          outputs: [
            { output_type: 'stream', name: 'stdout', text: 'log line\n'.repeat(500) },
            { output_type: 'display_data', metadata: {}, data: { 'image/png': b64(60_000), 'text/plain': '<image: 64 x 64>' } },
          ],
        },
        {
          cell_type: 'code',
          id: 'b',
          metadata: {},
          execution_count: 2,
          source: 'lab.play(samples)',
          outputs: [
            { output_type: 'display_data', metadata: {}, data: { 'text/html': `<audio controls src="data:audio/wav;base64,${b64(200_000)}"></audio>`, 'text/plain': '<audio: 2.00 s at 16000 Hz>' } },
            { output_type: 'execute_result', execution_count: 2, metadata: {}, data: { 'image/jpeg': b64(30_000) } },
            { output_type: 'display_data', metadata: {}, data: { 'text/html': '<table><tr><td>a table is text</td></tr></table>', 'image/svg+xml': '<svg></svg>' } },
          ],
        },
      ],
    }),
  )
}

describe('fitNotebook', () => {
  it('leaves a notebook that fits exactly as it is, as compact JSON', () => {
    const nb = sample()
    const fit = fitNotebook(nb, 1_000_000)
    expect(fit.fits).toBe(true)
    expect(fit.dropped).toEqual([])
    expect(JSON.parse(fit.text)).toEqual(JSON.parse(serializeNotebook(nb)))
    expect(fit.text).not.toContain('\n ')
    expect(fit.bytes).toBe(new TextEncoder().encode(fit.text).length)
  })

  it('drops the largest binary outputs first and only as many as needed', () => {
    const nb = sample()
    const fit = fitNotebook(nb, 150_000)
    expect(fit.fits).toBe(true)
    expect(fit.dropped).toEqual([{ cell: 3, kind: 'sound', bytes: expect.any(Number) }])
    expect(fit.bytes).toBeLessThanOrEqual(150_000)
    const saved = JSON.parse(fit.text)
    const audio = saved.cells[2].outputs[0].data
    expect(audio['text/html']).toBeUndefined()
    expect(audio['text/plain']).toMatch(/^<audio: 2\.00 s at 16000 Hz>\n\[sound output of 200 kB was not saved on the server/)
    expect(saved.cells[1].outputs[1].data['image/png'].join('')).toHaveLength(60_000)
    expect(describeDropped(fit.dropped)).toBe('the sound of cell 3 (200 kB)')
  })

  it('never drops code, Markdown, text outputs, tables or SVG drawings', () => {
    const nb = sample()
    const fit = fitNotebook(nb, 30_000)
    expect(fit.dropped.map((d) => [d.cell, d.kind])).toEqual([
      [3, 'sound'],
      [2, 'image'],
      [3, 'image'],
    ])
    const saved = JSON.parse(fit.text)
    expect(saved.cells[0].source.join('')).toBe(nb.cells[0].source)
    expect(saved.cells[1].source.join('')).toBe('lab.show(picture)')
    expect(saved.cells[1].outputs[0].text.join('')).toBe('log line\n'.repeat(500))
    expect(saved.cells[2].outputs[2].data['text/html'].join('')).toContain('a table is text')
    expect(saved.cells[2].outputs[2].data['image/svg+xml'].join('')).toBe('<svg></svg>')
    expect(saved.cells[2].outputs[1].data['text/plain']).toMatch(/^\[image output of 30 kB was not saved/)
    expect(fit.fits).toBe(true)
  })

  it('says so when the notebook is too large even without its binary outputs', () => {
    const fit = fitNotebook(sample(), 10_000)
    expect(fit.fits).toBe(false)
    expect(fit.dropped).toHaveLength(3)
    expect(fit.bytes).toBeGreaterThan(10_000)
  })

  it('does not change the notebook in memory, and counts bytes, not characters', () => {
    const nb = sample()
    const before = serializeNotebook(nb)
    fitNotebook(nb, 30_000)
    expect(serializeNotebook(nb)).toBe(before)
    const accents = parseNotebook(JSON.stringify({ nbformat: 4, metadata: {}, cells: [{ cell_type: 'markdown', id: 'x', metadata: {}, source: 'é'.repeat(1000) }] }))
    expect(fitNotebook(accents, 1500).fits).toBe(false)
    expect(fitNotebook(accents, 2500).fits).toBe(true)
  })

  it('hides secrets in what goes to the server', () => {
    const nb = parseNotebook(JSON.stringify({ nbformat: 4, metadata: {}, cells: [{ cell_type: 'code', id: 'x', metadata: {}, source: 'token = "hf_abcdefgh12345678"', outputs: [], execution_count: null }] }))
    const fit = fitNotebook(nb, 1_000_000, ['hf_abcdefgh12345678'])
    expect(fit.text).not.toContain('hf_abcdefgh12345678')
    expect(fit.text).toContain('[hidden: Hugging Face token]')
  })
})
