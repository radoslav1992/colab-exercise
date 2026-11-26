import { describe, expect, it } from 'vitest'
import {
  CHECK_TAG,
  cellTags,
  checkState,
  emptyNotebook,
  hasTag,
  newCell,
  NotebookFormatError,
  parseNotebook,
  REDACTED,
  redactText,
  serializeNotebook,
  setTag,
  splitLines,
  toIpynbObject,
  type DisplayOutput,
  type StreamOutput,
} from './ipynb.ts'

const sample = {
  cells: [
    {
      cell_type: 'markdown',
      id: 'intro',
      metadata: { custom: { keep: true } },
      attachments: { 'a.png': { 'image/png': 'AAAA' } },
      source: ['# Title\n', '\n', 'Text'],
    },
    {
      cell_type: 'code',
      id: 'code-1',
      metadata: { tags: ['check', 'other'], nbgrader: { grade: true, points: 2 } },
      execution_count: 3,
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['a\n', 'b\n'] },
        { output_type: 'stream', name: 'stderr', text: 'warn\n' },
        {
          output_type: 'execute_result',
          execution_count: 3,
          metadata: { 'image/png': { width: 10 } },
          data: { 'text/plain': ['line 1\n', 'line 2'], 'text/html': '<b>x</b>', 'application/json': { nested: [1, 2] }, 'image/png': 'iVBOR\n' },
        },
        { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['line 1', 'line 2'] },
        { output_type: 'update_display_data', data: { 'text/plain': 'x' }, metadata: {}, transient: { display_id: 'abc' } },
      ],
      source: 'print("a")\nprint("b")\n',
    },
    { cell_type: 'raw', id: 'raw-1', metadata: {}, source: 'raw text' },
  ],
  metadata: {
    kernelspec: { display_name: 'Python 3 (ipykernel)', language: 'python', name: 'python3' },
    language_info: { name: 'python', version: '3.12.0', codemirror_mode: { name: 'ipython', version: 3 } },
    colab: { provenance: [] },
    widgets: { state: {} },
  },
  nbformat: 4,
  nbformat_minor: 5,
}

describe('parseNotebook', () => {
  it('joins multi-line strings and keeps what it does not know', () => {
    const nb = parseNotebook(JSON.stringify(sample))
    expect(nb.cells.map((c) => [c.id, c.cell_type])).toEqual([
      ['intro', 'markdown'],
      ['code-1', 'code'],
      ['raw-1', 'raw'],
    ])
    expect(nb.cells[0].source).toBe('# Title\n\nText')
    expect(nb.cells[0].extra).toEqual({ attachments: { 'a.png': { 'image/png': 'AAAA' } } })
    expect(nb.cells[0].outputs).toEqual([])
    const [out, err, result, error, unknown] = nb.cells[1].outputs
    expect((out as StreamOutput).text).toBe('a\nb\n')
    expect((err as StreamOutput).name).toBe('stderr')
    expect((result as DisplayOutput).data['text/plain']).toBe('line 1\nline 2')
    expect((result as DisplayOutput).data['application/json']).toEqual({ nested: [1, 2] })
    expect(error).toMatchObject({ ename: 'ValueError', traceback: ['line 1', 'line 2'] })
    expect(unknown.output_type).toBe('update_display_data')
    expect(nb.cells[1].execution_count).toBe(3)
    expect(nb.metadata.colab).toEqual({ provenance: [] })
  })

  it('gives clear errors for files that are not notebooks', () => {
    expect(() => parseNotebook('not json')).toThrow(NotebookFormatError)
    expect(() => parseNotebook('not json')).toThrow(/not valid JSON/)
    expect(() => parseNotebook('[1, 2]')).toThrow(/not a Jupyter notebook/)
    expect(() => parseNotebook('{"nbformat": 3, "worksheets": []}')).toThrow(/nbformat 3/)
    expect(() => parseNotebook('{"nbformat": 4}')).toThrow(/list of cells/)
    expect(() => parseNotebook('{"cells": []}')).toThrow(NotebookFormatError)
  })

  it('creates ids for notebooks without them (nbformat 4.4) and repairs duplicates and invalid ids', () => {
    const nb = parseNotebook(
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 4,
        metadata: {},
        cells: [
          { cell_type: 'code', metadata: {}, source: '1', outputs: [], execution_count: null },
          { cell_type: 'code', id: 'same', metadata: {}, source: '2', outputs: [], execution_count: null },
          { cell_type: 'code', id: 'same', metadata: {}, source: '3', outputs: [], execution_count: null },
          { cell_type: 'code', id: 'has spaces!', metadata: {}, source: '4', outputs: [], execution_count: null },
        ],
      }),
    )
    const ids = nb.cells.map((c) => c.id)
    expect(new Set(ids).size).toBe(4)
    expect(ids[1]).toBe('same')
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(toIpynbObject(nb).nbformat_minor).toBe(5)
  })

  it('tolerates sloppy input: missing metadata, unknown cell types, junk in the cell list', () => {
    const nb = parseNotebook(
      JSON.stringify({
        nbformat: 4,
        cells: [null, 7, { cell_type: 'heading', source: ['old'] }, { cell_type: 'code', source: 'x', outputs: 'nonsense', execution_count: '3' }],
      }),
    )
    expect(nb.cells).toHaveLength(2)
    expect(nb.cells[0].cell_type).toBe('raw')
    expect(nb.cells[1].outputs).toEqual([])
    expect(nb.cells[1].execution_count).toBeNull()
    expect(nb.metadata).toEqual({})
  })
})

describe('serializeNotebook', () => {
  it('round-trips a notebook without changing it', () => {
    const text = serializeNotebook(parseNotebook(JSON.stringify(sample)))
    const result = JSON.parse(text)
    // Text that came in as one string goes out as lines; everything else is identical.
    const expected = structuredClone(sample)
    const outputs = expected.cells[1].outputs as Array<{ text?: unknown; data?: Record<string, unknown> }>
    outputs[1].text = ['warn\n']
    outputs[2].data!['text/html'] = ['<b>x</b>']
    outputs[2].data!['image/png'] = ['iVBOR\n']
    ;(expected.cells[1] as { source: unknown }).source = ['print("a")\n', 'print("b")\n']
    ;(expected.cells[2] as { source: unknown }).source = ['raw text']
    expect(result).toEqual(expected)
    // A second trip is exact.
    expect(serializeNotebook(parseNotebook(text))).toBe(text)
  })

  it('writes what Jupyter and Colab expect', () => {
    const text = serializeNotebook(parseNotebook(JSON.stringify(sample)))
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.startsWith('{\n "cells": [')).toBe(true)
    const result = JSON.parse(text)
    expect(result.nbformat).toBe(4)
    expect(result.nbformat_minor).toBe(5)
    expect(Object.keys(result.cells[0]).sort()).toEqual(['attachments', 'cell_type', 'id', 'metadata', 'source'])
    expect(Object.keys(result.cells[1]).sort()).toEqual(['cell_type', 'execution_count', 'id', 'metadata', 'outputs', 'source'])
    expect(result.cells[1].outputs[0]).toEqual({ output_type: 'stream', name: 'stdout', text: ['a\n', 'b\n'] })
    expect('execution_count' in result.cells[1].outputs[2]).toBe(true)
  })

  it('adds a kernelspec to a new notebook and gives new cells an id', () => {
    const nb = emptyNotebook()
    nb.cells.push(newCell('markdown', '# Hi'))
    const result = JSON.parse(serializeNotebook(nb))
    expect(result.metadata.kernelspec).toEqual({ display_name: 'Python 3', language: 'python', name: 'python3' })
    expect(result.metadata.language_info).toEqual({ name: 'python' })
    expect(result.cells[0]).toEqual({ cell_type: 'code', execution_count: null, id: nb.cells[0].id, metadata: {}, outputs: [], source: [] })
    expect(result.cells[1]).toEqual({ cell_type: 'markdown', id: nb.cells[1].id, metadata: {}, source: ['# Hi'] })
    expect(nb.cells[0].id).not.toBe(nb.cells[1].id)
  })

  it('can leave outputs out', () => {
    const result = JSON.parse(serializeNotebook(parseNotebook(JSON.stringify(sample)), { withoutOutputs: true }))
    expect(result.cells[1].outputs).toEqual([])
    expect(result.cells[1].execution_count).toBeNull()
    expect(result.cells[1].source).toEqual(['print("a")\n', 'print("b")\n'])
  })

  it('removes secrets from sources, outputs and metadata', () => {
    const token = 'hf_abcDEF0123456789xyz'
    const nb = parseNotebook(JSON.stringify(sample))
    nb.cells[1].source = `token = "${token}"\nprint(token)`
    nb.cells[1].outputs = [
      { output_type: 'stream', name: 'stdout', text: `${token}\n` },
      { output_type: 'display_data', metadata: {}, data: { 'text/html': `<p>${token}</p>`, 'application/json': { t: token } } },
      { output_type: 'error', ename: 'E', evalue: token, traceback: [`x ${token} y`] },
    ]
    nb.metadata.note = token
    const text = serializeNotebook(nb, { redact: [token] })
    expect(text).not.toContain(token)
    expect(text.split(REDACTED).length - 1).toBe(7)
    expect(() => JSON.parse(text)).not.toThrow()
    // Without the option, nothing is touched; very short "secrets" are ignored so that text is not shredded.
    expect(serializeNotebook(nb)).toContain(token)
    expect(redactText('abc abc', ['abc'])).toBe('abc abc')
    expect(redactText('x secret-value y', ['secret-value'])).toBe(`x ${REDACTED} y`)
  })
})

describe('splitLines', () => {
  it('keeps line endings, like Jupyter', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a')).toEqual(['a'])
    expect(splitLines('a\n')).toEqual(['a\n'])
    expect(splitLines('a\nb')).toEqual(['a\n', 'b'])
    expect(splitLines('a\n\nb\n')).toEqual(['a\n', '\n', 'b\n'])
    expect(splitLines('\n')).toEqual(['\n'])
    for (const text of ['', 'x', 'x\n', '\n\n', 'a\r\nb', 'a\nb\n\nc']) expect(splitLines(text).join('')).toBe(text)
  })
})

describe('tags and check cells', () => {
  it('adds and removes the check tag without touching other tags or metadata', () => {
    const nb = parseNotebook(JSON.stringify(sample))
    const cell = nb.cells[1]
    expect(hasTag(cell, CHECK_TAG)).toBe(true)
    setTag(cell, CHECK_TAG, false)
    expect(cellTags(cell)).toEqual(['other'])
    expect(cell.metadata.nbgrader).toEqual({ grade: true, points: 2 })
    setTag(cell, CHECK_TAG, true)
    setTag(cell, CHECK_TAG, true)
    expect(cellTags(cell)).toEqual(['other', 'check'])
    setTag(cell, 'other', false)
    setTag(cell, CHECK_TAG, false)
    expect('tags' in cell.metadata).toBe(false)
    const plain = newCell('code')
    setTag(plain, CHECK_TAG, true)
    expect(JSON.parse(serializeNotebook({ ...emptyNotebook(), cells: [plain] })).cells[0].metadata).toEqual({ tags: ['check'] })
  })

  it('ignores tags that are not a list of strings', () => {
    const cell = newCell('code')
    cell.metadata = { tags: 'check' }
    expect(hasTag(cell, CHECK_TAG)).toBe(false)
    cell.metadata = { tags: ['check', 3, null] }
    expect(cellTags(cell)).toEqual(['check'])
  })

  it('derives the check state from the cell', () => {
    const cell = newCell('code')
    expect(checkState(cell)).toBe('not-run')
    cell.execution_count = 1
    expect(checkState(cell)).toBe('passed')
    cell.outputs.push({ output_type: 'stream', name: 'stderr', text: 'a warning is not a failure' })
    expect(checkState(cell)).toBe('passed')
    cell.outputs.push({ output_type: 'error', ename: 'AssertionError', evalue: '', traceback: [] })
    expect(checkState(cell)).toBe('failed')
  })
})
