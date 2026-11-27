/**
 * The script of the landing page (index.html). The page is complete without it: this only adds
 * the theme button and the account controls, which depend on what this copy of the site offers
 * and on whether somebody is signed in in this browser. Nothing of the app is loaded here.
 */
import { SECRET_KEY } from './keys.ts'
import { themeSwitch } from './theme.ts'

const themeButton = document.getElementById('theme-button')
if (themeButton instanceof HTMLButtonElement) {
  themeSwitch(themeButton)
  themeButton.hidden = false
}

/** Whether this deployment has accounts (a database). A site without an API has none. */
async function accountsAvailable(): Promise<boolean> {
  try {
    const response = await fetch('/api/config', { headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store' })
    if (!response.ok || !(response.headers.get('content-type') ?? '').startsWith('application/json')) return false
    const config: unknown = await response.json()
    return typeof config === 'object' && config !== null && (config as { accounts?: unknown }).accounts === true
  } catch {
    return false
  }
}

/**
 * Whether this browser holds the secret of a session. Only that it is there is looked at, never
 * what it is; whether the session still exists is the app's question (src/session.ts).
 */
function maybeSignedIn(): boolean {
  try {
    return localStorage.getItem(SECRET_KEY) !== null
  } catch {
    return false
  }
}

void accountsAvailable().then((accounts) => {
  if (!accounts) {
    // No accounts here: no control that cannot work, and nothing that talks about joining a course.
    for (const node of document.querySelectorAll<HTMLElement>('[data-needs-accounts]')) node.hidden = true
    return
  }
  const state = maybeSignedIn() ? 'in' : 'out'
  for (const node of document.querySelectorAll<HTMLElement>('[data-account]')) node.hidden = node.dataset.account !== state
  document.documentElement.dataset.account = state
})
