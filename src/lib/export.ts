/**
 * What the teacher's downloads are made of: CSV text that a spreadsheet will not run as a formula,
 * and file names made from students' names that are safe in a zip file on any system.
 */

/**
 * One CSV cell. Text that starts with =, +, - or @ (or a tab or line break) would be run as a
 * formula by Excel and others, so it gets a leading apostrophe; then the usual CSV quoting.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  let text = value
  if (/^[=+\-@\t\r\n]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Rows to CSV text with CRLF line ends and a byte-order mark, so that Excel reads it as UTF-8. */
export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/**
 * A file name (without extension) from a person's name: letters, digits, "-", "_" and "." only,
 * no path separators, no leading dot, not a reserved Windows name, at most 60 characters.
 */
export function safeFileName(name: string, fallback = 'student'): string {
  let base = name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 60)
    .replace(/[._-]+$/g, '')
  if (!base) base = fallback
  if (RESERVED.test(base)) base = `${base}_`
  return base
}

/** Safe file names for a list of names, made unique (ignoring case) with -2, -3, ... */
export function uniqueFileNames(names: string[], extension: string, fallback = 'student'): string[] {
  const taken = new Set<string>()
  return names.map((name) => {
    const base = safeFileName(name, fallback)
    let candidate = base
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}`
    taken.add(candidate.toLowerCase())
    return `${candidate}${extension}`
  })
}
