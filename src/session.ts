/**
 * Who is signed in, and what this deployment offers. Read once when the page starts; views ask
 * here instead of asking the server again.
 */
import { api, ApiError, forgetSession, hasSessionSecret, setSignedOutHandler, type SiteConfig, type User } from './api.ts'
import type { Role } from '../shared/limits.ts'
import { deleteRemoteCopiesOf } from './storage.ts'

const NO_ACCOUNTS: SiteConfig = { accounts: false, passwordReset: false, controller: { name: '', contact: '' } }

let config: SiteConfig = NO_ACCOUNTS
let user: User | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Called whenever somebody signs in or out, or their name changes. Returns a function that stops the calls. */
export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function currentUser(): User | null {
  return user
}

export function siteConfig(): SiteConfig {
  return config
}

/** True when this deployment has accounts at all (a database is bound). Previews and static dev servers do not. */
export function accountsAvailable(): boolean {
  return config.accounts
}

/** Whether somebody is probably signed in, known before the server has answered. */
export function maybeSignedIn(): boolean {
  return hasSessionSecret()
}

function isConfig(value: unknown): value is SiteConfig {
  const c = value as Partial<SiteConfig> | null
  return typeof c === 'object' && c !== null && typeof c.accounts === 'boolean' && typeof c.controller === 'object' && c.controller !== null
}

/**
 * Ask the server what it offers and who is signed in. Never throws: a site without an API (a
 * preview without a database, a static dev server) simply has no accounts.
 */
export async function loadSession(): Promise<void> {
  try {
    const answer = await api.config()
    config = isConfig(answer)
      ? { accounts: answer.accounts, passwordReset: answer.passwordReset === true, controller: { name: String(answer.controller.name ?? ''), contact: String(answer.controller.contact ?? '') } }
      : NO_ACCOUNTS
  } catch {
    config = NO_ACCOUNTS
  }
  if (config.accounts && hasSessionSecret()) {
    try {
      user = (await api.session()).user
      // The secret no longer belongs to a session (signed out elsewhere, or expired).
      if (!user) forgetSession()
    } catch (err) {
      // Offline or a server error: keep the secret and try again on the next visit.
      user = null
      if (err instanceof ApiError && !err.temporary) forgetSession()
    }
  }
  setSignedOutHandler(() => {
    if (!user) return
    user = null
    forgetSession()
    emit()
  })
  emit()
}

export async function signIn(email: string, password: string): Promise<User> {
  user = (await api.login({ email, password })).user
  emit()
  return user
}

export async function signUp(details: { email: string; password: string; name: string; role: Role }): Promise<User> {
  user = (await api.register(details)).user
  emit()
  return user
}

export async function resetPassword(token: string, password: string): Promise<User> {
  user = (await api.reset(token, password)).user
  emit()
  return user
}

/** Sign out here: the server forgets the session, and this browser forgets the secret and the local copies of this person's work. */
export async function signOut(): Promise<void> {
  const leaving = user
  try {
    await api.logout()
  } catch {
    // Offline: the session stays on the server until it expires, but this browser forgets it.
  }
  forgetSession()
  if (leaving) deleteRemoteCopiesOf(leaving.id)
  user = null
  emit()
}

export function setUser(next: User): void {
  user = next
  emit()
}

/** After the account was deleted on the server. */
export function accountDeleted(): void {
  if (user) deleteRemoteCopiesOf(user.id)
  forgetSession()
  user = null
  emit()
}
