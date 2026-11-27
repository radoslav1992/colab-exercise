/** The sign-in dialog: sign in, create an account, or ask for a password reset. Uses <dialog>. */
import { LIMITS, type Role } from '../../shared/limits.ts'
import { api, ApiError } from '../api.ts'
import { signIn, signUp, siteConfig } from '../session.ts'
import { el, field, messageBox, uid } from './dom.ts'
import { doodle } from './doodle.ts'

type Mode = 'signin' | 'signup' | 'forgot'
export type AuthMode = 'signin' | 'signup'

const TITLES: Record<Mode, string> = {
  signin: 'Sign in',
  signup: 'Create an account',
  forgot: 'Forgot your password?',
}

let open = false

/** Open the dialog. `role` is the choice "I am a ..." that sign-up starts with. Resolves true when somebody is signed in afterwards. */
export function openAuthDialog(start: Mode = 'signin', role: Role = 'student'): Promise<boolean> {
  if (open) return Promise.resolve(false)
  open = true
  return new Promise((resolve) => {
    let mode: Mode = start
    let busy = false
    const titleId = uid('auth-title')
    const title = el('h2', { id: titleId })
    const intro = el('p', { class: 'dialog-intro' })
    const name = field('Your name', el('input', { type: 'text', autocomplete: 'name', maxLength: LIMITS.name }), 'As your teacher or your students should see it.')
    const email = field('Email', el('input', { type: 'email', autocomplete: 'username', inputMode: 'email', spellcheck: false }))
    const password = field('Password', el('input', { type: 'password', autocomplete: 'current-password' }))
    const teacher = el('input', { type: 'radio', name: 'auth-role', value: 'teacher', id: uid('role'), checked: role === 'teacher' })
    const student = el('input', { type: 'radio', name: 'auth-role', value: 'student', id: uid('role'), checked: role !== 'teacher' })
    const roleField = el('fieldset', { class: 'field choice' }, [
      el('legend', {}, ['I am a']),
      el('label', { htmlFor: student.id }, [student, ' student']),
      el('label', { htmlFor: teacher.id }, [teacher, ' teacher']),
      el('p', { class: 'field-help' }, ['This only decides what "My courses" shows first. You can teach some courses and be a student in others.']),
    ])
    const error = messageBox('error')
    const status = messageBox('status')
    const submit = el('button', { type: 'submit', class: 'button primary' })
    const cancel = el('button', { type: 'button', class: 'button' }, ['Cancel'])
    const toSignup = el('button', { type: 'button', class: 'link-button' }, ['Create an account'])
    const toSignin = el('button', { type: 'button', class: 'link-button' }, ['Sign in instead'])
    const toForgot = el('button', { type: 'button', class: 'link-button' }, ['Forgot your password?'])
    const switches = el('p', { class: 'dialog-switch' }, [toSignup, toSignin, toForgot])
    const form = el('form', { method: 'dialog', noValidate: true }, [
      el('div', { class: 'dialog-head' }, [title, doodle('plane')]),
      intro,
      name.row,
      email.row,
      password.row,
      roleField,
      error,
      status,
      el('div', { class: 'dialog-buttons' }, [cancel, submit]),
      switches,
    ])
    const dialog = el('dialog', { class: 'dialog' }, [form])
    dialog.setAttribute('aria-labelledby', titleId)

    const render = () => {
      const config = siteConfig()
      const forgotByHand = mode === 'forgot' && !config.passwordReset
      title.textContent = TITLES[mode]
      error.textContent = ''
      status.textContent = ''
      name.row.hidden = mode !== 'signup'
      roleField.hidden = mode !== 'signup'
      password.row.hidden = mode === 'forgot'
      email.row.hidden = forgotByHand
      submit.hidden = forgotByHand
      password.input.autocomplete = mode === 'signup' ? 'new-password' : 'current-password'
      submit.textContent = mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'
      toSignup.hidden = mode === 'signup'
      toSignin.hidden = mode === 'signin'
      toForgot.hidden = mode !== 'signin'
      cancel.textContent = forgotByHand ? 'Close' : 'Cancel'
      if (mode === 'signin') intro.textContent = 'Sign in to see your courses and assignments.'
      else if (mode === 'signup') intro.textContent = `Use a password with at least ${LIMITS.passwordMin} characters. No confirmation email is sent, so check the address.`
      else if (!forgotByHand) intro.textContent = 'Enter the email address of your account. If it has an account, a link to choose a new password is sent to it.'
      else {
        // No email can be sent from this site: a person sends the link (scripts/reset-link.ts).
        const contact = config.controller.contact
        intro.textContent = contact
          ? `Write to ${contact} from the email address of your account, and you will be sent a link to choose a new password.`
          : 'Ask your teacher, or whoever runs this site, for a link to choose a new password. It is sent to the email address of your account.'
      }
    }

    const close = (signedIn: boolean) => {
      open = false
      dialog.close()
      dialog.remove()
      resolve(signedIn)
    }
    const go = (next: Mode) => () => {
      if (busy) return
      mode = next
      render()
      ;(mode === 'signup' ? name.input : email.input).focus()
    }
    toSignup.addEventListener('click', go('signup'))
    toSignin.addEventListener('click', go('signin'))
    toForgot.addEventListener('click', go('forgot'))
    cancel.addEventListener('click', () => !busy && close(false))
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      if (!busy) close(false)
    })

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (busy) return
      error.textContent = ''
      status.textContent = ''
      const address = email.input.value.trim()
      const fail = (message: string, focus: HTMLElement) => {
        error.textContent = message
        focus.focus()
      }
      if (mode === 'signup' && !name.input.value.trim()) return fail('Enter your name.', name.input)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return fail('Enter a valid email address.', email.input)
      if (mode !== 'forgot' && password.input.value.length < (mode === 'signup' ? LIMITS.passwordMin : 1)) {
        return fail(mode === 'signup' ? `Use a password with at least ${LIMITS.passwordMin} characters.` : 'Enter your password.', password.input)
      }
      busy = true
      submit.disabled = true
      const done = () => {
        busy = false
        submit.disabled = false
      }
      const work: Promise<unknown> =
        mode === 'signin'
          ? signIn(address, password.input.value)
          : mode === 'signup'
            ? signUp({ email: address, password: password.input.value, name: name.input.value.trim(), role: (teacher.checked ? 'teacher' : 'student') as Role })
            : api.forgot(address)
      work.then(
        () => {
          done()
          if (mode === 'forgot') status.textContent = `If ${address} has an account, a reset link is on its way. It works once and for 60 minutes.`
          else close(true)
        },
        (err: unknown) => {
          done()
          error.textContent = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
        },
      )
    })

    render()
    document.body.append(dialog)
    dialog.showModal()
    ;(mode === 'signup' ? name.input : email.input).focus()
  })
}
