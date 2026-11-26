/**
 * Addresses of the views. Each view is a real file on the server (index.html is copied to
 * courses.html, course.html, ... when the site is built, see vite.config.ts), so reload and
 * back/forward work everywhere and an unknown address is a real 404. Which course or assignment a
 * view shows is in the query string.
 */

export type Route =
  | { view: 'home' }
  | { view: 'playground' }
  | { view: 'courses' }
  | { view: 'course'; id: string }
  | { view: 'assignment'; id: string }
  | { view: 'starter'; id: string }
  | { view: 'submission'; assignment: string; student: string }
  | { view: 'account' }
  | { view: 'privacy' }
  | { view: 'reset' }
  | { view: 'not-found' }

/** The pages besides index.html that the build writes. Keep in step with `parseRoute`. */
export const PAGES = ['playground', 'courses', 'course', 'assignment', 'starter', 'submission', 'account', 'privacy', 'reset'] as const

const ID = /^[a-z0-9]{20}$/

export function parseRoute(location: { pathname: string; search: string }): Route {
  const path = location.pathname.replace(/\/+$/, '') || '/'
  const query = new URLSearchParams(location.search)
  const id = query.get('id') ?? ''
  switch (path) {
    case '/':
      return { view: 'home' }
    case '/playground':
      return { view: 'playground' }
    case '/courses':
      return { view: 'courses' }
    case '/course':
      return ID.test(id) ? { view: 'course', id } : { view: 'not-found' }
    case '/assignment':
      return ID.test(id) ? { view: 'assignment', id } : { view: 'not-found' }
    case '/starter':
      return ID.test(id) ? { view: 'starter', id } : { view: 'not-found' }
    case '/submission': {
      const student = query.get('student') ?? ''
      return ID.test(id) && ID.test(student) ? { view: 'submission', assignment: id, student } : { view: 'not-found' }
    }
    case '/account':
      return { view: 'account' }
    case '/privacy':
      return { view: 'privacy' }
    case '/reset':
      return { view: 'reset' }
    default:
      return { view: 'not-found' }
  }
}

export function hrefFor(route: Route): string {
  switch (route.view) {
    case 'home':
    case 'not-found':
      return '/'
    case 'course':
    case 'assignment':
    case 'starter':
      return `/${route.view}?id=${route.id}`
    case 'submission':
      return `/submission?id=${route.assignment}&student=${route.student}`
    default:
      return `/${route.view}`
  }
}

type Listener = (route: Route) => void
let listener: Listener | null = null

/** Start routing: `onRoute` is called now and after every navigation, back and forward included. */
export function startRouter(onRoute: Listener): void {
  listener = onRoute
  window.addEventListener('popstate', () => onRoute(parseRoute(window.location)))
  onRoute(parseRoute(window.location))
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const href = hrefFor(route)
  if (options.replace) window.history.replaceState(null, '', href)
  else if (href !== window.location.pathname + window.location.search) window.history.pushState(null, '', href)
  listener?.(parseRoute(window.location))
}

/** A link to a view. A plain click navigates inside the page; anything else (new tab, ...) is the browser's. */
export function link(route: Route, text: string, className = ''): HTMLAnchorElement {
  const node = document.createElement('a')
  node.href = hrefFor(route)
  node.textContent = text
  if (className) node.className = className
  node.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(route)
  })
  return node
}
