import { describe, expect, it } from 'vitest'
import { csvCell, safeFileName, toCsv, uniqueFileNames } from './export.ts'

describe('CSV', () => {
  it('keeps a spreadsheet from running a cell as a formula', () => {
    expect(csvCell('=HYPERLINK("http://evil.example","x")')).toBe('"\'=HYPERLINK(""http://evil.example"",""x"")"')
    expect(csvCell('+1+1')).toBe("'+1+1")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('\t=1')).toBe("'\t=1")
    expect(csvCell('\r=1')).toBe('"\'\r=1"')
    expect(csvCell('plain = fine')).toBe('plain = fine')
  })

  it('quotes commas, quotes and line breaks, and writes numbers as they are', () => {
    expect(csvCell('Doe, Jane')).toBe('"Doe, Jane"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(8.5)).toBe('8.5')
    expect(csvCell(0)).toBe('0')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
    expect(csvCell(Number.NaN)).toBe('')
  })

  it('writes rows with CRLF and a byte-order mark', () => {
    expect(toCsv([['Name', 'Grade'], ['=cmd', 9]])).toBe("\uFEFFName,Grade\r\n'=cmd,9\r\n")
  })
})

describe('file names from student names', () => {
  it('keeps letters and digits of any script and nothing that means something to a file system', () => {
    expect(safeFileName('Jane Doe')).toBe('Jane_Doe')
    expect(safeFileName('Иван Петров')).toBe('Иван_Петров')
    expect(safeFileName('../../etc/passwd')).toBe('etc_passwd')
    expect(safeFileName('C:\\Windows\\system32')).toBe('C_Windows_system32')
    expect(safeFileName('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h')
    expect(safeFileName('.hidden.')).toBe('hidden')
    expect(safeFileName('  ')).toBe('student')
    expect(safeFileName('💥')).toBe('student')
    expect(safeFileName('con')).toBe('con_')
    expect(safeFileName('LPT1')).toBe('LPT1_')
    expect(safeFileName('x'.repeat(200))).toHaveLength(60)
    expect(safeFileName('line\nbreak\u0000null')).toBe('line_break_null')
  })

  it('makes the names unique, ignoring case', () => {
    expect(uniqueFileNames(['Ann Lee', 'ann lee', 'Ann-Lee', 'Ann Lee', '', ''], '.ipynb')).toEqual([
      'Ann_Lee.ipynb',
      'ann_lee-2.ipynb',
      'Ann-Lee.ipynb',
      'Ann_Lee-3.ipynb',
      'student.ipynb',
      'student-2.ipynb',
    ])
  })
})
