/**
 * Light or dark, for the landing page and the app. The choice is kept in this browser; without a
 * choice the page follows the system. public/theme.js applies a saved choice before the first
 * paint, so a page never flashes in the other theme.
 */
import { savedTheme, saveTheme, type Theme } from './storage.ts'

function effectiveTheme(): Theme {
  const set = document.documentElement.dataset.theme
  if (set === 'light' || set === 'dark') return set
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Make `button` the theme switch: it names the theme it switches to. */
export function themeSwitch(button: HTMLButtonElement): void {
  const show = () => {
    const now = effectiveTheme()
    button.textContent = now === 'dark' ? 'Light' : 'Dark'
    button.setAttribute('aria-label', now === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme')
  }
  const saved = savedTheme()
  if (saved) document.documentElement.dataset.theme = saved
  show()
  button.addEventListener('click', () => {
    const next: Theme = effectiveTheme() === 'dark' ? 'light' : 'dark'
    saveTheme(next)
    document.documentElement.dataset.theme = next
    show()
  })
  // Without a choice the page follows the system, and so does the label.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', show)
}
