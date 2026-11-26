/**
 * Autosave in the browser's localStorage. One slot per sample notebook (so a student's work on
 * each assignment survives) and one slot for the last opened file.
 *
 * Storage can be missing, blocked or full; every access is guarded and the caller shows the result.
 */
const PREFIX = 'notebook-lab:'
const CURRENT = `${PREFIX}current`
const THEME = `${PREFIX}theme`

export interface SavedDoc {
  /** "sample:<file name>" or "file". */
  id: string
  /** The file name shown and used for downloads. */
  name: string
  /** The notebook as `.ipynb` text. */
  text: string
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Nothing to remove if storage is blocked.
  }
}

export function loadDoc(id: string): SavedDoc | null {
  const raw = read(`${PREFIX}doc:${id}`)
  if (!raw) return null
  try {
    const doc = JSON.parse(raw) as Partial<SavedDoc>
    if (typeof doc.name === 'string' && typeof doc.text === 'string') return { id, name: doc.name, text: doc.text }
  } catch {
    // A damaged entry is treated as missing.
  }
  return null
}

export function saveDoc(doc: SavedDoc): boolean {
  return write(`${PREFIX}doc:${doc.id}`, JSON.stringify({ name: doc.name, text: doc.text })) && write(CURRENT, doc.id)
}

export function deleteDoc(id: string): void {
  remove(`${PREFIX}doc:${id}`)
}

export function currentDocId(): string | null {
  return read(CURRENT)
}

export function setCurrentDocId(id: string): void {
  write(CURRENT, id)
}

export type Theme = 'light' | 'dark'

export function savedTheme(): Theme | null {
  const value = read(THEME)
  return value === 'light' || value === 'dark' ? value : null
}

export function saveTheme(theme: Theme): void {
  write(THEME, theme)
}
