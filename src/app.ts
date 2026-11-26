/**
 * The page: the header (brand, navigation, account, theme), one view at a time, and the footer.
 * Which view shows is decided by the address (src/router.ts) and by who is signed in.
 *
 * Signed out, or on a deployment without a database, the site is the playground: the notebook
 * page of the prototype, saved in this browser only.
 */
import { api, ApiError, type User } from './api.ts'
import { link, navigate, startRouter, type Route } from './router.ts'
import { accountsAvailable, currentUser, loadSession, maybeSignedIn, onSessionChange } from './session.ts'
import { savedTheme, saveTheme, type Theme } from './storage.ts'
import { openAuthDialog } from './ui/auth.ts'
import { el } from './ui/dom.ts'
import { takeFlash } from './ui/flash.ts'
import { TeacherAssignmentPage } from './views/assignment.ts'
import { CourseView } from './views/course.ts'
import { CoursesView } from './views/courses.ts'
import { NotebookView, type View } from './views/notebook.ts'
import { errorContent, Page } from './views/page.ts'
import { ReviewView } from './views/review.ts'
import { AccountView, loadingView, notFoundView, privacyView, resetView, signInView } from './views/simple.ts'
import { StarterView } from './views/starter.ts'
import { WorkView } from './views/work.ts'

class ErrorView implements View {
  readonly root = el('main', { class: 'page' })

  constructor(err: unknown, retry: () => void) {
    this.root.id = 'main'
    document.title = `${err instanceof ApiError && err.status === 404 ? 'Not found' : 'Error'} · Notebook Lab`
    this.root.append(...errorContent(err, retry))
  }

  destroy(): void {
    this.root.remove()
  }
}

export class App {
  private readonly nav = el('nav', { class: 'site-nav' })
  private readonly tools = el('div', { class: 'site-tools' })
  private readonly themeButton = el('button', { type: 'button', class: 'button' })
  private readonly banner = el('p', { class: 'site-banner' })
  private readonly host = el('div', { class: 'view-host', id: 'content' })
  private view: View | null = null
  private viewKey = ''
  private route: Route = { view: 'home' }
  private sessionReady = false
  private ticket = 0
  private navigated = false

  constructor(private readonly root: HTMLElement) {
    const skip = el('a', { class: 'skip-link', href: '#content' }, ['Skip to the content'])
    const brand = link({ view: 'home' }, 'Notebook Lab', 'brand')
    this.nav.setAttribute('aria-label', 'Site')
    this.themeButton.addEventListener('click', () => this.toggleTheme())
    const header = el('header', { class: 'site-header' }, [el('div', { class: 'site-header-inner' }, [brand, this.nav, this.tools])])
    this.banner.setAttribute('role', 'status')
    this.banner.hidden = true
    this.host.tabIndex = -1
    const footer = el('footer', { class: 'site-footer' }, [link({ view: 'privacy' }, 'Privacy'), el('span', {}, ['Notebook Lab runs notebooks in your browser. No analytics, no tracking.'])])
    this.root.append(skip, header, this.banner, this.host, footer)
    this.applyTheme(savedTheme())
    this.renderHeader()
  }

  /**
   * Somebody without a session secret in this browser is signed out for certain, so the playground
   * shows at once and the server is asked in the background (only to learn whether to offer
   * "Sign in"). Otherwise the page waits for the server to say who is signed in.
   */
  async start(): Promise<void> {
    const signedOut = !maybeSignedIn()
    if (signedOut) startRouter((route) => this.show(route))
    await loadSession()
    this.sessionReady = true
    onSessionChange(() => {
      this.renderHeader()
      this.show(this.route)
    })
    this.renderHeader()
    if (signedOut) this.show(this.route)
    else startRouter((route) => this.show(route))
  }

  // --- Header -----------------------------------------------------------------------------------

  private renderHeader(): void {
    const user = currentUser()
    const current = this.route.view
    const item = (route: Route, text: string, active: boolean) => {
      const node = link(route, text)
      if (active) node.setAttribute('aria-current', 'page')
      return node
    }
    this.nav.replaceChildren()
    this.nav.hidden = !user
    if (user) {
      this.nav.append(
        item({ view: 'courses' }, 'My courses', ['courses', 'course', 'assignment', 'starter', 'submission'].includes(current)),
        item({ view: 'playground' }, 'Playground', current === 'playground'),
      )
    }
    this.tools.replaceChildren()
    if (user) {
      const account = item({ view: 'account' }, user.name, current === 'account')
      account.classList.add('account-link')
      account.title = `Account of ${user.email}`
      this.tools.append(account)
    } else if (this.sessionReady && accountsAvailable()) {
      // Only where signing in can work: not on a deployment without a database.
      const signIn = el('button', { type: 'button', class: 'button primary' }, ['Sign in'])
      signIn.addEventListener('click', () => void openAuthDialog('signin'))
      this.tools.append(signIn)
    }
    this.tools.append(this.themeButton)
  }

  private effectiveTheme(): Theme {
    const set = document.documentElement.dataset.theme
    if (set === 'light' || set === 'dark') return set
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  private applyTheme(theme: Theme | null): void {
    if (theme) document.documentElement.dataset.theme = theme
    const now = this.effectiveTheme()
    this.themeButton.textContent = now === 'dark' ? 'Light' : 'Dark'
    this.themeButton.setAttribute('aria-label', now === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme')
  }

  private toggleTheme(): void {
    const next: Theme = this.effectiveTheme() === 'dark' ? 'light' : 'dark'
    saveTheme(next)
    this.applyTheme(next)
  }

  // --- Views ------------------------------------------------------------------------------------

  /** Show the view for an address. Does nothing if that view is already showing. */
  private show(route: Route): void {
    this.route = route
    this.renderHeader()
    const user = currentUser()
    const needsAccount = (key: string, make: (user: User) => View | Promise<View>): [string, () => View | Promise<View>] => {
      if (!this.sessionReady) return ['loading', loadingView]
      if (!user) return [`sign-in:${accountsAvailable()}`, signInView]
      return [`${key}:${user.id}`, () => make(user)]
    }
    const playground = (): View => {
      const view = new NotebookView({ mode: 'playground' })
      void view.start()
      return view
    }

    let key: string
    let make: () => View | Promise<View>
    switch (route.view) {
      case 'home':
        // Home is "My courses" for somebody who is signed in, and the playground for everybody else.
        if (user) {
          navigate({ view: 'courses' }, { replace: true })
          return
        }
        if (!this.sessionReady && maybeSignedIn()) [key, make] = ['loading', loadingView]
        else [key, make] = ['playground', playground]
        break
      case 'playground':
        ;[key, make] = ['playground', playground]
        break
      case 'courses':
        ;[key, make] = needsAccount('courses', (u) => new CoursesView(u))
        break
      case 'course':
        ;[key, make] = needsAccount(`course:${route.id}`, () => new CourseView(route.id))
        break
      case 'assignment':
        ;[key, make] = needsAccount(`assignment:${route.id}`, async (u) => {
          const data = await api.assignment(route.id)
          if (data.role === 'teacher') return new TeacherAssignmentPage(data)
          const view = new WorkView(u, data)
          try {
            await view.start()
          } catch (err) {
            view.destroy()
            throw err
          }
          return view
        })
        break
      case 'starter':
        ;[key, make] = needsAccount(`starter:${route.id}`, async (u) => {
          const view = new StarterView(u, route.id)
          try {
            await view.start()
          } catch (err) {
            view.destroy()
            throw err
          }
          return view
        })
        break
      case 'submission':
        ;[key, make] = needsAccount(`submission:${route.assignment}:${route.student}`, async () => new ReviewView(await api.submission(route.assignment, route.student)))
        break
      case 'account':
        ;[key, make] = needsAccount('account', (u) => new AccountView(u))
        break
      case 'privacy':
        ;[key, make] = [`privacy:${this.sessionReady}`, privacyView]
        break
      case 'reset':
        ;[key, make] = ['reset', resetView]
        break
      default:
        ;[key, make] = ['not-found', notFoundView]
    }
    if (key === this.viewKey) return
    this.viewKey = key
    void this.mount(make)
  }

  private async mount(make: () => View | Promise<View>): Promise<void> {
    const ticket = ++this.ticket
    let view: View
    try {
      const made = make()
      if (made instanceof Promise) {
        this.swap(loadingView())
        view = await made
      } else {
        view = made
      }
    } catch (err) {
      view = new ErrorView(err, () => {
        this.viewKey = ''
        this.show(this.route)
      })
    }
    // The address changed while this view was loading.
    if (ticket !== this.ticket) {
      view.destroy()
      return
    }
    this.swap(view)
    // A message from the page before ("Your account was deleted") on views that have no message line.
    this.banner.hidden = true
    if (!(view instanceof Page)) {
      const flash = takeFlash()
      this.banner.textContent = flash
      this.banner.hidden = flash === ''
    }
    // After a navigation inside the page, the keyboard continues at the top of the new view.
    if (this.navigated) {
      window.scrollTo({ top: 0 })
      this.host.focus({ preventScroll: true })
    }
    this.navigated = true
  }

  private swap(view: View): void {
    this.view?.destroy()
    this.view = view
    this.host.replaceChildren(view.root)
  }
}
