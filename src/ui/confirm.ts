/** A dialog that asks before something happens: what will happen, and two buttons. Uses <dialog>. */
import { el, field, messageBox, uid } from './dom.ts'

export interface ConfirmOptions {
  title: string
  /** Paragraphs (strings) or ready-made elements (a list of what will be deleted). */
  body: Array<string | Node>
  confirm: string
  cancel?: string
  /** The confirm button is red: the action cannot be undone. */
  danger?: boolean
  /** Ask for the account's password and hand it to `run`. */
  password?: boolean
  /**
   * Do the thing. While it runs the buttons are off; if it throws, the message is shown in the
   * dialog and the dialog stays open.
   */
  run?(password: string): Promise<void>
}

/** Resolves true when the person confirmed (and `run`, if given, succeeded), false when they cancelled. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const titleId = uid('confirm-title')
    const error = messageBox('error')
    const confirm = el('button', { type: 'submit', class: options.danger ? 'button danger-solid' : 'button primary' }, [options.confirm])
    const cancel = el('button', { type: 'button', class: 'button' }, [options.cancel ?? 'Cancel'])
    const passwordInput = el('input', { type: 'password', autocomplete: 'current-password', required: true })
    const form = el('form', { method: 'dialog', noValidate: true }, [
      el('h2', { id: titleId }, [options.title]),
      ...options.body.map((part) => (typeof part === 'string' ? el('p', {}, [part]) : part)),
      options.password ? field('Your password', passwordInput).row : null,
      error,
      el('div', { class: 'dialog-buttons' }, [cancel, confirm]),
    ])
    const dialog = el('dialog', { class: 'dialog' }, [form])
    dialog.setAttribute('aria-labelledby', titleId)

    const close = (result: boolean) => {
      dialog.close()
      dialog.remove()
      resolve(result)
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (options.password && !passwordInput.value) {
        error.textContent = 'Enter your password.'
        passwordInput.focus()
        return
      }
      if (!options.run) return close(true)
      confirm.disabled = true
      cancel.disabled = true
      error.textContent = ''
      options.run(passwordInput.value).then(
        () => close(true),
        (err: unknown) => {
          confirm.disabled = false
          cancel.disabled = false
          error.textContent = String((err as Error)?.message ?? err)
        },
      )
    })
    cancel.addEventListener('click', () => close(false))
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      if (!cancel.disabled) close(false)
    })
    document.body.append(dialog)
    dialog.showModal()
    ;(options.password ? passwordInput : options.danger ? cancel : confirm).focus()
  })
}
