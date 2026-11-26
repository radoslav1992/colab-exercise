/**
 * The student's own Hugging Face token.
 *
 * It lives in this browser's localStorage (or only in memory if storage is blocked) and in no other
 * place: it is not sent to the worker that runs notebook code, not written into notebook files,
 * not logged, and used only by src/runtime/host.ts for requests to Hugging Face.
 */
const KEY = 'notebook-lab:hf-token'

let memory: string | null = null
const listeners = new Set<(set: boolean) => void>()

export function getToken(): string | null {
  try {
    return localStorage.getItem(KEY) ?? memory
  } catch {
    return memory
  }
}

export function hasToken(): boolean {
  return Boolean(getToken())
}

export function setToken(token: string | null): void {
  memory = token
  try {
    if (token) localStorage.setItem(KEY, token)
    else localStorage.removeItem(KEY)
  } catch {
    // Storage is blocked: the token is kept for this visit only.
  }
  for (const listener of listeners) listener(Boolean(token))
}

/** Called with true or false whenever the token is set or removed. Returns a function that stops the calls. */
export function onTokenChange(listener: (set: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Every secret that must be removed from text before it is shown or saved. */
export function secrets(): string[] {
  const token = getToken()
  return token ? [token] : []
}
