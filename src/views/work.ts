/**
 * A student's view of an assignment: what is asked, their own copy of the notebook (saved on the
 * server while they work), the Submit button, and, once the teacher released them, grade and
 * feedback.
 */
import { api, ApiError, type MyWork, type StudentAssignmentView, type User } from '../api.ts'
import { renderMarkdown } from '../notebook/markdown.ts'
import { link } from '../router.ts'
import { remoteKey } from '../storage.ts'
import { confirmDialog } from '../ui/confirm.ts'
import { el, formatDateTime, formatNumber } from '../ui/dom.ts'
import type { View } from './notebook.ts'
import { RemoteNotebook } from './remote.ts'

/** "Checks reported by the browser: 2 of 3 passed", the wording used wherever these numbers show. */
export function reportedChecks(passed: number | null, total: number | null): string {
  if (total === null || passed === null) return 'no check cells reported'
  return `${passed} of ${total} check${total === 1 ? '' : 's'} passed`
}

export const REPORTED_NOTE = "reported by the student's browser, not proof"

export class WorkView implements View {
  readonly root: HTMLElement
  private readonly remote: RemoteNotebook
  private readonly statusEl = el('p', { class: 'panel-status' })
  private readonly gradeEl = el('div', { class: 'panel-grade' })
  private readonly submitButton = el('button', { type: 'button', class: 'button primary submit-button' }, ['Submit'])
  private mine: MyWork
  private submitting = false

  constructor(
    user: User,
    private data: StudentAssignmentView,
  ) {
    const { assignment, course } = data
    this.mine = data.mine
    this.statusEl.setAttribute('role', 'status')
    this.submitButton.title = 'Hand in the notebook as it is now. You can submit again until the assignment is closed.'
    this.submitButton.addEventListener('click', () => void this.submit())

    const meta = [
      assignment.dueAt !== null ? `Due ${formatDateTime(assignment.dueAt)}` : 'No due date',
      assignment.points !== null ? `${formatNumber(assignment.points)} point${assignment.points === 1 ? '' : 's'}` : null,
    ].filter(Boolean)
    const instructions = el('div', { class: 'markdown' })
    // Instructions are Markdown from the teacher, sanitized like every notebook.
    instructions.innerHTML = renderMarkdown(assignment.instructions)
    const panel = el('section', { class: 'assignment-panel' }, [
      el('p', { class: 'crumbs' }, [link({ view: 'courses' }, 'My courses'), ' › ', link({ view: 'course', id: course.id }, course.name)]),
      el('div', { class: 'panel-head' }, [el('h1', {}, [assignment.title]), assignment.state === 'closed' || course.archived ? el('span', { class: 'badge' }, ['Closed']) : null]),
      el('p', { class: 'panel-meta' }, [meta.join(' · ')]),
      assignment.instructions ? el('details', { class: 'instructions', open: true }, [el('summary', {}, ['Instructions']), instructions]) : null,
      this.statusEl,
      this.gradeEl,
    ])
    panel.setAttribute('aria-label', 'Assignment')

    this.remote = new RemoteNotebook(
      {
        key: remoteKey('work', user.id, assignment.id),
        load: () => api.openWork(assignment.id),
        save: (text, version) => api.saveWork(assignment.id, text, version),
        reader: 'your teacher sees',
      },
      {
        heading: 'Your copy',
        panel,
        actions: [this.submitButton],
        savedWhere: 'Your work is saved on the server while you type, and in this browser.',
      },
    )
    this.root = this.remote.view.root
    document.title = `${assignment.title} · Notebook Lab`
    this.showMine()
  }

  /** Load the notebook. Throws if the server cannot be asked. */
  start(): Promise<void> {
    return this.remote.start()
  }

  private get closed(): boolean {
    return this.data.assignment.state !== 'published' || this.data.course.archived
  }

  private showMine(): void {
    const { mine } = this
    const { assignment } = this.data
    const parts: string[] = []
    if (mine.submittedAt === null) {
      parts.push(this.closed ? 'This assignment is closed. You did not submit.' : 'Not submitted yet. Your work is saved as you go; press Submit to hand it in.')
    } else {
      parts.push(`Submitted ${formatDateTime(mine.submittedAt)}${mine.late ? ' (late)' : ''}`)
      if (mine.submissions > 1) parts.push(`${mine.submissions} submissions, the latest one counts`)
      parts.push(`your browser reported ${reportedChecks(mine.checksPassed, mine.checksTotal)}`)
      if (!this.closed) parts.push('you can submit again until the assignment is closed')
    }
    this.statusEl.dataset.status = mine.status
    this.statusEl.textContent = parts.join(' · ')
    this.submitButton.disabled = this.closed
    this.submitButton.textContent = mine.submittedAt === null ? 'Submit' : 'Submit again'
    if (this.closed) this.submitButton.title = 'This assignment is closed. It no longer takes submissions.'

    this.gradeEl.replaceChildren()
    this.gradeEl.hidden = !mine.graded
    if (mine.graded) {
      const grade =
        mine.grade === null ? 'No grade' : assignment.points !== null ? `${formatNumber(mine.grade)} of ${formatNumber(assignment.points)}` : formatNumber(mine.grade)
      this.gradeEl.append(el('h2', {}, ['Grade and feedback']), el('p', { class: 'grade-value' }, [`Grade: ${grade}`]))
      if (mine.gradedBeforeLatest) this.gradeEl.append(el('p', { class: 'field-help' }, ['This grade was given for an earlier submission than your latest one.']))
      if (mine.feedback) {
        const feedback = el('div', { class: 'markdown feedback' })
        // Feedback is Markdown from the teacher, sanitized like every notebook.
        feedback.innerHTML = renderMarkdown(mine.feedback)
        this.gradeEl.append(feedback)
      }
    }
  }

  private async submit(): Promise<void> {
    if (this.submitting || this.closed) return
    const view = this.remote.view
    if (view.busy) {
      view.notify('A cell is still running. Wait until it has finished, then submit.')
      return
    }
    const { assignment } = this.data
    const checks = view.checks()
    const late = assignment.dueAt !== null && Date.now() > assignment.dueAt
    const confirmed = await confirmDialog({
      title: this.mine.submittedAt === null ? 'Submit this notebook?' : 'Submit again?',
      body: [
        'Your teacher gets the notebook as it is now, with its outputs. You can submit again until the assignment is closed; the latest submission counts.',
        checks.total > 0
          ? `In your last run, ${reportedChecks(checks.passed, checks.total)}. This is sent along as a report from your browser.`
          : 'This notebook has no check cells.',
        ...(late ? ['The due time has passed: this submission will be marked late.'] : []),
        ...(this.mine.submittedAt !== null ? ['This replaces your earlier submission.'] : []),
      ],
      confirm: 'Submit',
    })
    if (!confirmed) return
    this.submitting = true
    this.submitButton.disabled = true
    try {
      // What is handed in is the copy on the server, so that copy must be up to date first.
      if (!(await this.remote.flush())) {
        const reason = this.remote.state?.message
        view.notify(`Not submitted: your latest changes are not on the server yet${reason ? ` (${reason})` : ''}. Wait for "Saved on the server", then submit again.`)
        return
      }
      const result = await api.submit(assignment.id, {
        version: this.remote.version,
        checksPassed: checks.total > 0 ? checks.passed : null,
        checksTotal: checks.total > 0 ? checks.total : null,
      })
      this.mine = {
        ...this.mine,
        status: result.late ? 'late' : 'submitted',
        submittedAt: result.submittedAt,
        late: result.late,
        submissions: result.submissions,
        checksPassed: result.checksPassed,
        checksTotal: result.checksTotal,
        gradedBeforeLatest: this.mine.graded,
      }
      view.notify(`Submitted ${formatDateTime(result.submittedAt)}${result.late ? ', after the due time (late)' : ''}.`)
    } catch (err) {
      if (err instanceof ApiError && err.data.closed === true) {
        this.data = { ...this.data, assignment: { ...this.data.assignment, state: 'closed' } }
      }
      view.notify(`Not submitted: ${(err as Error).message}`)
    } finally {
      this.submitting = false
      this.showMine()
    }
  }

  destroy(): void {
    this.remote.destroy()
  }
}
