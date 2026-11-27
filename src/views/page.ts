/** Shared pieces of the pages that are not notebooks: loading, errors, the message line, small table helpers. */
import { ApiError } from '../api.ts'
import { link, type Route } from '../router.ts'
import { el } from '../ui/dom.ts'
import { takeFlash } from '../ui/flash.ts'
import type { View } from './notebook.ts'

/**
 * A page that loads its data from the server and draws itself again after every change. The
 * message line at the top says what just happened and is announced by screen readers.
 */
export abstract class Page implements View {
  readonly root = el('main', { class: 'page' })
  protected readonly message = el('p', { class: 'page-message' })
  protected alive = true
  private loaded = false

  constructor() {
    this.root.id = 'main'
    this.message.setAttribute('role', 'status')
    this.message.hidden = true
    this.root.append(this.message, el('p', { class: 'page-loading' }, ['Loading…']))
    const flash = takeFlash()
    if (flash) this.say(flash)
  }

  /** Fetch what the page shows and return its content. */
  protected abstract load(): Promise<Array<Node | null>>

  /** Load (again) and draw. */
  async refresh(): Promise<void> {
    try {
      const content = await this.load()
      if (!this.alive) return
      this.loaded = true
      this.root.replaceChildren(this.message, ...content.filter((node): node is Node => node !== null))
    } catch (err) {
      if (!this.alive) return
      // After a failed reload the page keeps what it showed and says what went wrong.
      if (this.loaded) this.say(errorText(err), true)
      else this.root.replaceChildren(this.message, ...errorContent(err, () => void this.refresh()))
    }
  }

  /** Show a line at the top of the page: what just happened, or what went wrong. */
  protected say(text: string, isError = false): void {
    this.message.textContent = text
    this.message.hidden = text === ''
    this.message.classList.toggle('is-error', isError)
    if (text && isError) this.message.scrollIntoView({ block: 'nearest' })
  }

  /** Run a change on the server, then load the page again. Errors are shown in the message line. */
  protected async act(work: () => Promise<unknown>, done: string): Promise<boolean> {
    try {
      await work()
    } catch (err) {
      if (this.alive) this.say(errorText(err), true)
      return false
    }
    if (!this.alive) return true
    this.say(done)
    await this.refresh()
    return true
  }

  destroy(): void {
    this.alive = false
    this.root.remove()
  }
}

export function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : String((err as Error)?.message ?? err)
}

/** What a page shows when its data could not be loaded. */
export function errorContent(err: unknown, retry: () => void): Node[] {
  const missing = err instanceof ApiError && err.status === 404
  const retryButton = el('button', { type: 'button', class: 'button' }, ['Try again'])
  retryButton.addEventListener('click', retry)
  return [
    el('h1', {}, [missing ? 'Not found' : 'This page could not be loaded']),
    el('p', {}, [errorText(err)]),
    el('p', { class: 'form-buttons' }, [missing ? null : retryButton, link({ view: 'courses' }, 'My courses', 'button')]),
  ]
}

/** "My courses › NLP 101 › Homework 1" as links. */
export function crumbs(parts: Array<[Route, string]>): HTMLElement {
  const node = el('p', { class: 'crumbs' })
  parts.forEach(([route, text], index) => {
    if (index > 0) node.append(' › ')
    node.append(link(route, text))
  })
  return node
}

/** A table whose cells carry their column's name, so that narrow screens can show each row as a card. */
export function table(caption: string, columns: string[], rows: Array<Array<Node | string>>, className = ''): HTMLElement {
  const head = el('tr', {}, columns.map((name) => el('th', { scope: 'col' }, [name])))
  const body = rows.map((cells) =>
    el(
      'tr',
      {},
      cells.map((cell, index) => {
        const td = el(index === 0 ? 'th' : 'td', {}, [cell])
        if (index === 0) td.setAttribute('scope', 'row')
        td.dataset.label = columns[index]
        return td
      }),
    ),
  )
  const node = el('table', { class: `data-table ${className}`.trim() }, [el('caption', { class: 'visually-hidden' }, [caption]), el('thead', {}, [head]), el('tbody', {}, body)])
  return el('div', { class: 'table-wrap' }, [node])
}

const STATE_TEXT: Record<string, string> = {
  draft: 'Draft',
  published: 'Published',
  closed: 'Closed',
  'not-started': 'Not started',
  'in-progress': 'In progress',
  submitted: 'Submitted',
  late: 'Submitted late',
  archived: 'Archived',
}

/** A small label for a state. The text says everything; the colour only helps. */
export function badge(state: string, text = STATE_TEXT[state] ?? state): HTMLElement {
  const node = el('span', { class: 'badge' }, [text])
  node.dataset.state = state
  return node
}
