/** The small pages: privacy, account, new password, sign-in prompt, not found. */
import { LIMITS, type Role } from '../../shared/limits.ts'
import { api, type User } from '../api.ts'
import { CONTROLLER_PLACEHOLDER, PRIVACY_UPDATED, privacySections } from '../legal.ts'
import { link, navigate } from '../router.ts'
import { accountDeleted, accountsAvailable, resetPassword, setUser, signOut, siteConfig } from '../session.ts'
import { openAuthDialog } from '../ui/auth.ts'
import { confirmDialog } from '../ui/confirm.ts'
import { button, el, field, formatDate, messageBox, uid } from '../ui/dom.ts'
import { setFlash } from '../ui/flash.ts'
import type { View } from './notebook.ts'
import { errorText, Page } from './page.ts'

/** A page without data from the server. */
class StaticPage implements View {
  readonly root = el('main', { class: 'page' })

  constructor(title: string, content: Array<Node | null>) {
    this.root.id = 'main'
    document.title = `${title} · Notebook Lab`
    this.root.append(...content.filter((node): node is Node => node !== null))
  }

  destroy(): void {
    this.root.remove()
  }
}

export function notFoundView(): View {
  return new StaticPage('Page not found', [
    el('h1', {}, ['Page not found']),
    el('p', {}, ['There is nothing at this address.']),
    el('p', { class: 'form-buttons' }, [link({ view: 'home' }, 'Go to the start', 'button')]),
  ])
}

export function loadingView(): View {
  return new StaticPage('Notebook Lab', [el('p', { class: 'page-loading' }, ['Loading…'])])
}

/** A page that needs an account, opened by somebody who is not signed in. */
export function signInView(): View {
  if (!accountsAvailable()) {
    return new StaticPage('Accounts are not available', [
      el('h1', {}, ['Accounts are not available here']),
      el('p', {}, ['This copy of the site has no accounts (it has no database). The playground works as usual: notebooks run and are saved in this browser.']),
      el('p', { class: 'form-buttons' }, [link({ view: 'playground' }, 'Open the playground', 'button primary')]),
    ])
  }
  return new StaticPage('Sign in', [
    el('h1', {}, ['Sign in to continue']),
    el('p', {}, ['Courses, assignments and submissions need an account.']),
    el('p', { class: 'form-buttons' }, [
      button('Sign in', () => void openAuthDialog('signin'), 'button primary'),
      button('Create an account', () => void openAuthDialog('signup')),
      link({ view: 'playground' }, 'Open the playground', 'button'),
    ]),
  ])
}

export function privacyView(): View {
  const config = siteConfig()
  const sections = privacySections(config.controller, config.accounts)
  const placeholder = !config.controller.name || !config.controller.contact
  const content: Array<Node | null> = [
    el('h1', {}, ['Privacy']),
    el('p', { class: 'page-meta' }, [`Last changed ${PRIVACY_UPDATED}`]),
    placeholder
      ? el('p', { class: 'placeholder-warning' }, [
          'This page is not complete: the name and the contact of the data controller are not configured for this site. Where they belong, the text below says so.',
        ])
      : null,
  ]
  for (const section of sections) {
    content.push(el('h2', {}, [section.heading]))
    for (const block of section.blocks) {
      const mark = (text: string): Array<Node | string> => {
        // The placeholder stands out; everything else is plain text.
        const parts = text.split(CONTROLLER_PLACEHOLDER)
        return parts.flatMap((part, index) => (index === 0 ? [part] : [el('mark', { class: 'placeholder' }, [CONTROLLER_PLACEHOLDER]), part]))
      }
      content.push(typeof block === 'string' ? el('p', {}, mark(block)) : el('ul', {}, block.map((item) => el('li', {}, mark(item)))))
    }
  }
  const view = new StaticPage('Privacy', content)
  view.root.classList.add('prose')
  return view
}

/** Choose a new password with the token from a reset link (/reset#token=...). */
export function resetView(): View {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? ''
  // The token is not kept in the address bar or the history.
  if (token) window.history.replaceState(null, '', '/reset')
  const password = field('New password', el('input', { type: 'password', autocomplete: 'new-password' }), `At least ${LIMITS.passwordMin} characters.`)
  const error = messageBox('error')
  const save = el('button', { type: 'submit', class: 'button primary' }, ['Set password and sign in'])
  const form = el('form', { class: 'card-form', noValidate: true }, [password.row, error, el('div', { class: 'form-buttons' }, [save])])
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    error.textContent = ''
    if (password.input.value.length < LIMITS.passwordMin) {
      error.textContent = `Use a password with at least ${LIMITS.passwordMin} characters.`
      password.input.focus()
      return
    }
    save.disabled = true
    resetPassword(token, password.input.value).then(
      () => {
        setFlash('Your password is changed, and you are signed in. Other devices were signed out.')
        navigate({ view: 'courses' }, { replace: true })
      },
      (err: unknown) => {
        save.disabled = false
        error.textContent = errorText(err)
      },
    )
  })
  return new StaticPage('New password', [
    el('h1', {}, ['Choose a new password']),
    token
      ? form
      : el('p', {}, ['This page needs the link from a password reset email. Open the link from the email again, or ask for a new one from the sign-in dialog.']),
  ])
}

export class AccountView extends Page {
  constructor(private user: User) {
    super()
    document.title = 'Account · Notebook Lab'
    void this.refresh()
  }

  protected async load(): Promise<Array<Node | null>> {
    const { teaching, enrolled } = await api.courses()
    const user = this.user

    // Name and role
    const name = field('Name', el('input', { type: 'text', autocomplete: 'name', maxLength: LIMITS.name, value: user.name }), 'Your teacher and your students see this name.')
    const group = uid('role')
    const student = el('input', { type: 'radio', name: group, id: uid('role'), checked: user.role === 'student' })
    const teacher = el('input', { type: 'radio', name: group, id: uid('role'), checked: user.role === 'teacher' })
    const role = el('fieldset', { class: 'field choice' }, [
      el('legend', {}, ['I am mostly a']),
      el('label', { htmlFor: student.id }, [student, ' student']),
      el('label', { htmlFor: teacher.id }, [teacher, ' teacher']),
      el('p', { class: 'field-help' }, ['This only decides which courses "My courses" shows first.']),
    ])
    const profileForm = el('form', { class: 'card-form', noValidate: true }, [name.row, role, el('div', { class: 'form-buttons' }, [el('button', { type: 'submit', class: 'button primary' }, ['Save'])])])
    profileForm.addEventListener('submit', (event) => {
      event.preventDefault()
      void this.act(async () => {
        const updated = (await api.updateProfile({ name: name.input.value, role: (teacher.checked ? 'teacher' : 'student') as Role })).user
        this.user = updated
        setUser(updated)
      }, 'Saved.')
    })

    // Password
    const current = field('Current password', el('input', { type: 'password', autocomplete: 'current-password' }))
    const next = field('New password', el('input', { type: 'password', autocomplete: 'new-password' }), `At least ${LIMITS.passwordMin} characters. Other devices are signed out.`)
    const passwordError = messageBox('error')
    const passwordForm = el('form', { class: 'card-form', noValidate: true }, [
      // Password managers want the account's name next to the password fields.
      el('input', { type: 'text', autocomplete: 'username', value: user.email, hidden: true }),
      current.row,
      next.row,
      passwordError,
      el('div', { class: 'form-buttons' }, [el('button', { type: 'submit', class: 'button primary' }, ['Change password'])]),
    ])
    passwordForm.addEventListener('submit', (event) => {
      event.preventDefault()
      passwordError.textContent = ''
      if (next.input.value.length < LIMITS.passwordMin) {
        passwordError.textContent = `Use a new password with at least ${LIMITS.passwordMin} characters.`
        next.input.focus()
        return
      }
      api.changePassword(current.input.value, next.input.value).then(
        () => {
          current.input.value = ''
          next.input.value = ''
          this.say('Password changed. Other devices were signed out.')
        },
        (err: unknown) => {
          passwordError.textContent = errorText(err)
        },
      )
    })

    // Delete: say exactly what goes.
    const students = teaching.reduce((sum, c) => sum + c.students, 0)
    const doomed = [
      `Your account: your name, your email address (${user.email}), your password and your sessions on every device.`,
      teaching.length > 0
        ? `The ${teaching.length} course${teaching.length === 1 ? '' : 's'} you teach (${teaching.map((c) => c.name).join(', ')}), with all assignments and starter notebooks, and the work, submissions and grades of all ${students} student${students === 1 ? '' : 's'} in ${teaching.length === 1 ? 'it' : 'them'}.`
        : 'No courses: you do not teach any.',
      enrolled.length > 0
        ? `Your membership in ${enrolled.length} course${enrolled.length === 1 ? '' : 's'} (${enrolled.map((c) => c.name).join(', ')}), with your notebooks, your submissions and your grades there.`
        : 'No course work: you are not a student in any course.',
      'The copies of your course notebooks in this browser.',
    ]
    const list = () => el('ul', {}, doomed.map((item) => el('li', {}, [item])))
    const remove = button(
      'Delete my account',
      () =>
        void confirmDialog({
          title: 'Delete your account?',
          body: ['This deletes, for good:', list(), 'It cannot be undone. Download the notebooks you want to keep first.'],
          confirm: 'Delete my account',
          danger: true,
          password: true,
          run: (password) => api.deleteAccount(password).then(() => undefined),
        }).then((gone) => {
          if (!gone) return
          accountDeleted()
          setFlash('Your account and its data were deleted.')
          navigate({ view: 'home' })
        }),
      'button danger',
    )

    return [
      el('h1', {}, ['Account']),
      el('p', { class: 'page-meta' }, [`${user.email} · signed up ${formatDate(user.createdAt)}`]),
      el('section', { class: 'page-section' }, [el('h2', {}, ['Name']), profileForm]),
      el('section', { class: 'page-section' }, [el('h2', {}, ['Password']), passwordForm]),
      el('section', { class: 'page-section' }, [
        el('h2', {}, ['Sign out']),
        el('p', {}, ['Signing out also removes the copies of your course notebooks from this browser. They stay on the server.']),
        button('Sign out', () => void signOut().then(() => navigate({ view: 'home' }))),
      ]),
      el('section', { class: 'page-section' }, [
        el('h2', {}, ['Delete account']),
        el('p', {}, ['Deleting your account deletes:']),
        list(),
        el('p', {}, ['What stays: nothing of yours. See the ', link({ view: 'privacy' }, 'privacy page'), ' for details.']),
        remove,
      ]),
    ]
  }
}
