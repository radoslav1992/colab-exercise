/**
 * A teacher looks at one submission: the notebook as the student handed it in, with its stored
 * outputs (sanitized like every notebook), and the grade and feedback. The teacher can run and
 * change cells; nothing done here is saved, and the submission stays as it was handed in.
 *
 * The notebook is code from somebody else. It runs in the worker like any notebook, and the worker
 * cannot use the teacher's session: see "Security model" in the README.
 */
import { LIMITS } from '../../shared/limits.ts'
import { api, type SubmissionView } from '../api.ts'
import { safeFileName } from '../lib/export.ts'
import { notebookFromObject } from '../notebook/ipynb.ts'
import { link } from '../router.ts'
import { el, field, formatDateTime, formatNumber, messageBox } from '../ui/dom.ts'
import { NotebookView, type View } from './notebook.ts'
import { REPORTED_NOTE, reportedChecks } from './work.ts'

/** The submitted notebook as `.ipynb` text, exactly as stored. */
export function submissionText(notebook: unknown): string {
  return JSON.stringify(notebook, null, 1) + '\n'
}

export class ReviewView implements View {
  readonly root: HTMLElement
  private readonly view: NotebookView

  constructor(data: SubmissionView) {
    const { assignment, student } = data
    const original = submissionText(data.notebook)

    const gradeInput = el('input', { type: 'number', min: '0', max: String(LIMITS.maxPoints), step: '0.01', inputMode: 'decimal', value: data.grade === null ? '' : formatNumber(data.grade) })
    const feedbackInput = el('textarea', { rows: 4, maxLength: LIMITS.feedback, value: data.feedback })
    const save = el('button', { type: 'submit', class: 'button primary' }, ['Save grade'])
    const status = messageBox('status')
    const error = messageBox('error')
    const released = el('p', { class: 'field-help' })
    const showReleased = () => {
      released.replaceChildren(
        assignment.gradesReleased
          ? 'The grades of this assignment are released: the student sees this grade and feedback as soon as you save.'
          : 'The grades of this assignment are not released yet: the student does not see this. Release them on the ',
        ...(assignment.gradesReleased ? [] : [link({ view: 'assignment', id: assignment.id }, 'assignment page'), '.']),
      )
    }
    showReleased()
    const form = el('form', { class: 'grade-form', noValidate: true }, [
      el('h2', {}, ['Grade and feedback']),
      field(assignment.points !== null ? `Grade (of ${formatNumber(assignment.points)} points)` : 'Grade (a number, optional)', gradeInput).row,
      field('Feedback (plain text or Markdown, optional)', feedbackInput).row,
      el('div', { class: 'form-buttons' }, [save, status]),
      error,
      released,
    ])
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      error.textContent = ''
      status.textContent = ''
      const text = gradeInput.value.trim()
      const grade = text === '' ? null : Number(text)
      if (grade !== null && (!Number.isFinite(grade) || grade < 0 || grade > LIMITS.maxPoints)) {
        error.textContent = `A grade is a number from 0 to ${LIMITS.maxPoints}, or empty.`
        gradeInput.focus()
        return
      }
      save.disabled = true
      api.grade(assignment.id, student.id, { grade, feedback: feedbackInput.value }).then(
        (result) => {
          save.disabled = false
          gradeInput.value = result.grade === null ? '' : formatNumber(result.grade)
          feedbackInput.value = result.feedback
          status.textContent = result.gradedAt === null ? 'Saved: no grade.' : `Saved ${formatDateTime(result.gradedAt)}.`
        },
        (err: unknown) => {
          save.disabled = false
          error.textContent = String((err as Error)?.message ?? err)
        },
      )
    })

    const facts = el('dl', { class: 'facts' }, [
      el('dt', {}, ['Submitted']),
      el('dd', {}, [formatDateTime(data.submittedAt), data.late ? el('span', { class: 'badge late' }, ['Late']) : null]),
      el('dt', {}, ['Submissions']),
      el('dd', {}, [data.submissions === 1 ? '1' : `${data.submissions} (this is the latest)`]),
      el('dt', {}, ['Checks']),
      el('dd', {}, [reportedChecks(data.checksPassed, data.checksTotal), el('span', { class: 'reported-note' }, [` (${REPORTED_NOTE})`])]),
      ...(assignment.dueAt !== null ? [el('dt', {}, ['Due']), el('dd', {}, [formatDateTime(assignment.dueAt)])] : []),
    ])

    const panel = el('section', { class: 'assignment-panel review-panel' }, [
      el('p', { class: 'crumbs' }, [
        link({ view: 'courses' }, 'My courses'),
        ' › ',
        link({ view: 'course', id: assignment.courseId }, assignment.courseName),
        ' › ',
        link({ view: 'assignment', id: assignment.id }, assignment.title),
      ]),
      el('div', { class: 'panel-head' }, [el('h1', {}, [student.name])]),
      el('p', { class: 'panel-meta' }, [student.email]),
      el('div', { class: 'review-columns' }, [facts, form]),
      el('p', { class: 'review-note' }, [
        'Below is the notebook as it was submitted, with the outputs the student saw. You can run and change cells to try things; nothing you do here is saved or changes the submission. "Download" saves the submitted file.',
      ]),
    ])
    panel.setAttribute('aria-label', 'Submission')

    this.view = new NotebookView({
      mode: 'review',
      heading: 'Submission',
      panel,
      savedWhere: 'Nothing you change on this page is saved.',
      downloadText: () => original,
    })
    this.root = this.view.root
    document.title = `${student.name}: ${assignment.title} · Notebook Lab`
    this.view.show(notebookFromObject(data.notebook), `${safeFileName(student.name)}.ipynb`)
    this.view.showSave('unsaved', 'Review copy: changes are not saved')
  }

  destroy(): void {
    this.view.destroy()
  }
}
