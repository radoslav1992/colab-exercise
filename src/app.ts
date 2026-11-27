/**
 * The app: the header (brand, navigation, account, theme), one view at a time, and the footer.
 * Which view shows is decided by the address (src/router.ts) and by who is signed in.
 *
 * The start page of the site is not part of the app: "/" is the landing page (index.html,
 * src/landing.ts). Signed out, or on a deployment without a database, the app is the playground:
 * the notebook page with the sample notebooks, saved in this browser only.
 */
import { api, ApiError, type User } from './api.ts'
import { link, navigate, startRouter, type Route } from './router.ts'
import { accountsAvailable, currentUser, loadSession, maybeSignedIn, onSessionChange } from './session.ts'
import { samples } from './samples.ts'
import { themeSwitch } from './theme.ts'
import { openAuthDialog, type AuthMode } from './ui/auth.ts'
import { el } from './ui/dom.ts'
import { doodle, emptyState } from './ui/doodle.ts'
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
    const missing = err instanceof ApiError && err.status === 404
    document.title = `${missing ? 'Not found' : 'Error'} · Notebook Lab`
    const [heading, text, ...rest] = errorContent(err, retry)
    // The same drawing as on the "Page not found" page.
    if (missing) this.root.append(heading, emptyState('not-found', text.textContent ?? '', 'lost'), ...rest)
    else this.root.append(heading, text, ...rest)
  }

  destroy(): void {
    this.root.remove()
  }
}

export class App {
  private readonly nav = el('nav', { class: 'site-nav' })
  private readonly tools = el('div', { class: 'site-tools' })
  private readonly brand = el('a', { class: 'brand', href: '/' }, [doodle('mark'), el('span', {}, ['Notebook Lab'])])
  private readonly themeButton = el('button', { type: 'button', class: 'button theme-button' })
  private readonly banner = el('p', { class: 'site-banner' })
  private readonly host = el('div', { class: 'view-host', id: 'content' })
  private view: View | null = null
  private viewKey = ''
  private route: Route = { view: 'playground' }
  private sessionReady = false
  private ticket = 0
  private navigated = false

  constructor(private readonly root: HTMLElement) {
    const skip = el('a', { class: 'skip-link', href: '#content' }, ['Skip to the content'])
    // The brand goes home: "My courses" inside the app for somebody who is signed in, the landing page (another document) for everybody else.
    this.brand.addEventListener('click', (event) => {
      if (!currentUser() || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      navigate({ view: 'courses' })
    })
    this.nav.setAttribute('aria-label', 'Site')
    themeSwitch(this.themeButton)
    const header = el('header', { class: 'site-header' }, [el('div', { class: 'site-header-inner' }, [this.brand, this.nav, this.tools])])
    this.banner.setAttribute('role', 'status')
    this.banner.hidden = true
    this.host.tabIndex = -1
    const footer = el('footer', { class: 'site-footer' }, [link({ view: 'privacy' }, 'Privacy'), el('span', {}, ['Notebook Lab runs notebooks in your browser. No analytics, no tracking.'])])
    this.root.append(skip, header, this.banner, this.host, footer)
    this.renderHeader()
  }

  /**
   * Somebody without a session secret in this browser is signed out for certain, so the playground
   * shows at once and the server is asked in the background (only to learn whether to offer
   * "Sign in"). Otherwise the page waits for the server to say who is signed in.
   */
  async start(): Promise<void> {
    const wanted = takeAuthRequest()
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
    // "Sign in" or "Create an account" on the landing page: the dialog opens over the page they lead to.
    if (wanted && !currentUser() && accountsAvailable()) void openAuthDialog(wanted.mode, wanted.role)
  }

  // --- Header -----------------------------------------------------------------------------------

  private renderHeader(): void {
    const user = currentUser()
    const current = this.route.view
    this.brand.href = user ? '/courses' : '/'
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
    let key: string
    let make: () => View | Promise<View>
    switch (route.view) {
      case 'playground': {
        // "/playground?sample=03-llm-tokens-and-sampling" opens that sample, if there is one. The
        // address then becomes "/playground": which notebook is open is remembered by the browser.
        const sample = route.sample ? samples.find((s) => s.file === `${route.sample}.ipynb`) : undefined
        if (route.sample) {
          window.history.replaceState(null, '', '/playground')
          this.route = { view: 'playground' }
          if (sample) this.viewKey = ''
        }
        key = 'playground'
        make = () => {
          const view = new NotebookView({ mode: 'playground', open: sample?.file })
          void view.start()
          return view
        }
        break
      }
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

/**
 * The landing page links to "/courses?auth=signin" and "/courses?auth=signup" (with "&role=teacher"
 * for a teacher). The request is taken out of the address at once, so that a reload or the back
 * button does not open the dialog again.
 */
function takeAuthRequest(): { mode: AuthMode; role?: 'teacher' | 'student' } | null {
  const query = new URLSearchParams(window.location.search)
  const mode = query.get('auth')
  if (mode === null) return null
  const role = query.get('role')
  query.delete('auth')
  query.delete('role')
  const rest = query.toString()
  window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''))
  if (mode !== 'signin' && mode !== 'signup') return null
  return { mode, role: role === 'teacher' || role === 'student' ? role : undefined }
}
