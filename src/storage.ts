/**
 * Autosave in the browser's localStorage. For the playground: one slot per sample notebook and one
 * for the last opened file. For signed-in work (a student's copy of an assignment, a teacher's
 * starter): one slot per person and assignment, which also remembers which version of the server's
 * copy it is based on, so that work survives being offline and is synced afterwards.
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

// --- Copies of notebooks that also live on the server ---------------------------------------------

const REMOTE = `${PREFIX}remote:`

export interface RemoteCopy {
  /** The file name shown and used for downloads. */
  name: string
  /** The notebook as `.ipynb` text. */
  text: string
  /** The version of the server's copy that this text is based on. */
  baseVersion: number
  /** True while this text has changes that the server does not have yet. */
  dirty: boolean
}

/** "work" or "starter", the person and the assignment: one slot each. */
export function remoteKey(kind: 'work' | 'starter', userId: string, assignmentId: string): string {
  return `${kind}:${userId}:${assignmentId}`
}

export function loadRemoteCopy(key: string): RemoteCopy | null {
  const raw = read(`${REMOTE}${key}`)
  if (!raw) return null
  try {
    const copy = JSON.parse(raw) as Partial<RemoteCopy>
    if (typeof copy.name === 'string' && typeof copy.text === 'string' && typeof copy.baseVersion === 'number') {
      return { name: copy.name, text: copy.text, baseVersion: copy.baseVersion, dirty: copy.dirty === true }
    }
  } catch {
    // A damaged entry is treated as missing.
  }
  return null
}

export function saveRemoteCopy(key: string, copy: RemoteCopy): boolean {
  return write(`${REMOTE}${key}`, JSON.stringify(copy))
}

export function deleteRemoteCopy(key: string): void {
  remove(`${REMOTE}${key}`)
}

/** Remove every local copy of one person's server notebooks (when they sign out or delete their account). */
export function deleteRemoteCopiesOf(userId: string): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(REMOTE) && key.slice(REMOTE.length).split(':')[1] === userId) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch {
    // Nothing to remove if storage is blocked.
  }
}

export type Theme = 'light' | 'dark'

export function savedTheme(): Theme | null {
  const value = read(THEME)
  return value === 'light' || value === 'dark' ? value : null
}

export function saveTheme(theme: Theme): void {
  write(THEME, theme)
}
