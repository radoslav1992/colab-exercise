/**
 * An assignment as its teacher sees it: its details and state, the starter notebook, and the
 * table of all students with their submissions, grades and the downloads (zip, CSV).
 */
import { strToU8, zipSync } from 'fflate'
import { LIMITS, MAX_NOTEBOOK_BYTES } from '../../shared/limits.ts'
import { api, type StudentRow, type TeacherAssignmentView } from '../api.ts'
import { safeFileName, toCsv, uniqueFileNames } from '../lib/export.ts'
import { describeDropped, fitNotebook } from '../notebook/fit.ts'
import { parseNotebook } from '../notebook/ipynb.ts'
import { renderMarkdown } from '../notebook/markdown.ts'
import { secrets } from '../runtime/token.ts'
import { link, navigate } from '../router.ts'
import { confirmDialog } from '../ui/confirm.ts'
import { button, downloadBlob, el, field, formatDateTime, formatNumber, fromLocalInput, messageBox, toLocalInput } from '../ui/dom.ts'
import { setFlash } from '../ui/flash.ts'
import { badge, crumbs, errorText, Page, table } from './page.ts'
import { submissionText } from './review.ts'
import { REPORTED_NOTE } from './work.ts'

const STATUS_WORDS: Record<StudentRow['status'], string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  submitted: 'Submitted',
  late: 'Submitted late',
}

/** The table as CSV rows, for a spreadsheet. Times are UTC (ISO 8601). */
export function gradesCsv(data: TeacherAssignmentView): string {
  const { assignment, students } = data
  const rows: Array<Array<string | number | null>> = [
    ['Student', 'Email', 'Status', 'Submitted at (UTC)', 'Late', 'Submissions', `Checks passed (${REPORTED_NOTE})`, 'Checks total', 'Grade', 'Points', 'Feedback'],
  ]
  for (const s of students) {
    rows.push([
      s.name,
      s.email,
      STATUS_WORDS[s.status],
      s.submittedAt === null ? '' : new Date(s.submittedAt).toISOString(),
      s.submittedAt === null ? '' : s.status === 'late' ? 'yes' : 'no',
      s.submissions,
      s.checksPassed,
      s.checksTotal,
      s.grade,
      assignment.points,
      s.feedback,
    ])
  }
  return toCsv(rows)
}

export class TeacherAssignmentPage extends Page {
  private busy = false

  constructor(private data: TeacherAssignmentView) {
    super()
    void this.refresh(data)
  }

  override async refresh(first?: TeacherAssignmentView): Promise<void> {
    this.first = first ?? null
    await super.refresh()
  }

  private first: TeacherAssignmentView | null = null

  protected async load(): Promise<Array<Node | null>> {
    const loaded = this.first ?? (await api.assignment(this.data.assignment.id))
    this.first = null
    if (loaded.role !== 'teacher') throw new Error('You no longer teach this course.')
    this.data = loaded
    const { assignment, course, students, counts } = loaded
    document.title = `${assignment.title} · Notebook Lab`
    const id = assignment.id

    // --- Head: title, state, what students see ---------------------------------------------------
    const meta = [
      assignment.dueAt !== null ? `Due ${formatDateTime(assignment.dueAt)}` : 'No due date',
      assignment.points !== null ? `${formatNumber(assignment.points)} point${assignment.points === 1 ? '' : 's'}` : 'No points set',
    ]
    const instructions = el('div', { class: 'markdown' })
    // Instructions are Markdown, sanitized like every notebook.
    instructions.innerHTML = renderMarkdown(assignment.instructions)

    const stateHelp = {
      draft: 'Draft: students do not see this assignment. Publish it when the starter notebook is ready.',
      published: 'Published: students in the course see it, get their own copy when they open it, and can submit.',
      closed: 'Closed: students still see it and their own copy, but can no longer submit.',
    }[assignment.state]
    const setState = (state: 'published' | 'closed', done: string) => () => void this.act(() => api.updateAssignment(id, { state }), done)
    const stateButton =
      assignment.state === 'draft'
        ? button('Publish', setState('published', 'Published. Students in the course can now open it.'), 'button primary')
        : assignment.state === 'published'
          ? button('Close', setState('closed', 'Closed. No more submissions are taken.'))
          : button('Open again', setState('published', 'Open again: students can submit.'))
    if (course.archived && assignment.state !== 'published') stateButton.disabled = true

    const head = [
      crumbs([
        [{ view: 'courses' }, 'My courses'],
        [{ view: 'course', id: course.id }, course.name],
      ]),
      el('div', { class: 'page-head' }, [el('h1', {}, [assignment.title]), badge(assignment.state)]),
      el('p', { class: 'page-meta' }, [meta.join(' · ')]),
      assignment.instructions ? el('details', { class: 'instructions' }, [el('summary', {}, ['Instructions']), instructions]) : null,
      el('div', { class: 'state-row' }, [el('p', { class: 'field-help' }, [stateHelp]), stateButton]),
    ]

    // --- Starter notebook --------------------------------------------------------------------------
    const file = el('input', { type: 'file', accept: '.ipynb,application/x-ipynb+json,application/json', hidden: true })
    file.addEventListener('change', () => {
      const chosen = file.files?.[0]
      file.value = ''
      if (chosen) void this.replaceStarter(chosen)
    })
    const starterButtons = el('div', { class: 'form-buttons' }, [
      assignment.state === 'draft' ? link({ view: 'starter', id }, 'Edit starter', 'button') : null,
      button('Replace with a file', () => file.click()),
      button('Download starter', () => void this.downloadStarter()),
      file,
    ])
    const starter = el('section', { class: 'page-section' }, [
      el('h2', {}, ['Starter notebook']),
      el('p', {}, [el('strong', {}, [assignment.starter.name]), `, last changed ${formatDateTime(assignment.starter.updatedAt)}`]),
      el('p', { class: 'field-help' }, [
        assignment.state === 'draft'
          ? 'Each student gets their own copy of this notebook when they first open the assignment. Students never receive anything else, so keep solutions out of it.'
          : 'This assignment is published: replacing the starter affects only students who have not opened the assignment yet. Everybody who has started keeps their copy.',
      ]),
      starterButtons,
    ])

    // --- Details -----------------------------------------------------------------------------------
    const title = field('Title', el('input', { type: 'text', maxLength: LIMITS.title, value: assignment.title }))
    const text = field('Instructions (Markdown, optional)', el('textarea', { rows: 5, maxLength: LIMITS.instructions, value: assignment.instructions }))
    const due = field('Due date and time (optional)', el('input', { type: 'datetime-local', value: toLocalInput(assignment.dueAt) }), 'In your time zone. Lateness is decided by the server\'s clock when a student submits.')
    const pointsField = field('Points (optional)', el('input', { type: 'number', min: '0', max: String(LIMITS.maxPoints), step: '0.01', inputMode: 'decimal', value: assignment.points === null ? '' : formatNumber(assignment.points) }))
    const detailsError = messageBox('error')
    const detailsForm = el('form', { class: 'card-form', noValidate: true }, [title.row, text.row, due.row, pointsField.row, detailsError, el('div', { class: 'form-buttons' }, [el('button', { type: 'submit', class: 'button primary' }, ['Save details'])])])
    detailsForm.addEventListener('submit', (event) => {
      event.preventDefault()
      detailsError.textContent = ''
      const dueAt = fromLocalInput(due.input.value)
      if (due.input.value && dueAt === null) {
        detailsError.textContent = 'The due date is not a valid date and time.'
        return
      }
      const pointsText = pointsField.input.value.trim()
      const points = pointsText === '' ? null : Number(pointsText)
      if (points !== null && !Number.isFinite(points)) {
        detailsError.textContent = 'Points must be a number.'
        return
      }
      void this.act(() => api.updateAssignment(id, { title: title.input.value, instructions: text.input.value, dueAt, points }), 'Details saved.')
    })
    const details = el('details', { class: 'disclosure' }, [el('summary', {}, ['Edit title, instructions, due date and points']), detailsForm])

    // --- Submissions ---------------------------------------------------------------------------------
    const handedIn = counts.submitted + counts.late
    const chips = el('ul', { class: 'counts' }, [
      el('li', {}, [el('strong', {}, [String(counts.enrolled)]), ' enrolled']),
      el('li', {}, [el('strong', {}, [String(counts.notStarted)]), ' not started']),
      el('li', {}, [el('strong', {}, [String(counts.inProgress)]), ' in progress']),
      el('li', {}, [el('strong', {}, [String(counts.submitted)]), ' submitted']),
      el('li', {}, [el('strong', {}, [String(counts.late)]), ' submitted late']),
      el('li', {}, [el('strong', {}, [String(counts.graded)]), ' graded']),
    ])
    chips.setAttribute('aria-label', 'Counts')

    const rows = students.map((s) => [
      el('span', { class: 'student-name' }, [s.name, el('span', { class: 'student-email' }, [s.email])]),
      badge(s.status),
      s.submittedAt === null ? '' : `${formatDateTime(s.submittedAt)}${s.submissions > 1 ? ` (${s.submissions} submissions)` : ''}`,
      s.checksTotal === null || s.checksPassed === null ? '' : `${s.checksPassed} of ${s.checksTotal}`,
      s.grade === null ? '' : assignment.points !== null ? `${formatNumber(s.grade)} of ${formatNumber(assignment.points)}` : formatNumber(s.grade),
      s.feedback.length > 80 ? `${s.feedback.slice(0, 80)}…` : s.feedback,
      s.submittedAt === null ? '' : link({ view: 'submission', assignment: id, student: s.id }, s.gradedAt === null ? 'Open and grade' : 'Open', 'button small'),
    ])

    const zip = button('Download all (.zip)', () => void this.downloadAll())
    zip.disabled = handedIn === 0
    const csv = button('Export table (.csv)', () => {
      downloadBlob(new Blob([gradesCsv(this.data)], { type: 'text/csv;charset=utf-8' }), `${safeFileName(assignment.title, 'assignment')}-grades.csv`)
    })
    const release = assignment.gradesReleased
      ? button('Take the release back', () => void this.act(() => api.updateAssignment(id, { gradesReleased: false }), 'Students no longer see grades and feedback of this assignment.'))
      : button('Release grades to students', () => {
          void confirmDialog({
            title: 'Release grades and feedback?',
            body: [
              `Students will see their grade and feedback for this assignment: ${counts.graded} of ${handedIn} submission${handedIn === 1 ? '' : 's'} ${counts.graded === 1 ? 'is' : 'are'} graded so far.`,
              'Grades you save after this are visible to the student at once. You can take the release back.',
            ],
            confirm: 'Release',
            run: () => api.updateAssignment(id, { gradesReleased: true }).then(() => undefined),
          }).then((ok) => ok && this.act(async () => {}, 'Released: students now see their grade and feedback.'))
        }, 'button primary')
    const releaseState = el('p', { class: 'release-state' }, [
      assignment.gradesReleased ? 'Grades and feedback are released: each student sees their own.' : 'Grades and feedback are not released: students do not see them yet.',
    ])
    releaseState.dataset.released = String(assignment.gradesReleased)

    const submissions = el('section', { class: 'page-section' }, [
      el('h2', {}, ['Students and submissions']),
      chips,
      students.length > 0
        ? table('Students and submissions', ['Student', 'Status', 'Submitted', 'Checks', 'Grade', 'Feedback', 'Submission'], rows, 'submissions')
        : el('p', { class: 'empty' }, ['Nobody is enrolled in the course yet.']),
      el('p', { class: 'field-help' }, [`Checks: how many check cells passed in the student's last run, ${REPORTED_NOTE}. A student can change what their browser reports; run the notebook yourself to be sure.`]),
      el('div', { class: 'release-row' }, [releaseState, release]),
      el('div', { class: 'form-buttons' }, [zip, csv]),
    ])

    // --- Delete --------------------------------------------------------------------------------------
    const remove = button(
      'Delete assignment',
      () =>
        void confirmDialog({
          title: `Delete ${assignment.title}?`,
          body: [`This deletes the assignment, its starter notebook and, for every student, their copy, their submission and their grade for it. It cannot be undone.`],
          confirm: 'Delete the assignment',
          danger: true,
          run: () => api.deleteAssignment(id).then(() => undefined),
        }).then((ok) => {
          if (!ok) return
          setFlash(`${assignment.title} was deleted.`)
          navigate({ view: 'course', id: course.id })
        }),
      'button danger',
    )

    return [...head, starter, details, submissions, el('section', { class: 'page-section' }, [el('h2', {}, ['Delete']), remove])]
  }

  private async replaceStarter(file: File): Promise<void> {
    const { assignment } = this.data
    try {
      const fit = fitNotebook(parseNotebook(await file.text()), MAX_NOTEBOOK_BYTES, secrets())
      if (!fit.fits) throw new Error('This notebook is larger than 1 MB even without its pictures and sound. Clear its outputs and try again.')
      if (assignment.state !== 'draft') {
        const ok = await confirmDialog({
          title: 'Replace the starter notebook?',
          body: ['This assignment is published. The new starter reaches only students who have not opened the assignment yet; everybody who has started keeps their copy.'],
          confirm: 'Replace',
        })
        if (!ok) return
      }
      await this.act(
        () => api.saveStarter(assignment.id, fit.text, assignment.starter.version, file.name),
        fit.dropped.length > 0 ? `Starter replaced, without ${describeDropped(fit.dropped)} (a stored notebook is limited to 1 MB).` : 'Starter replaced.',
      )
    } catch (err) {
      this.say(errorText(err), true)
    }
  }

  private async downloadStarter(): Promise<void> {
    try {
      const starter = await api.starter(this.data.assignment.id)
      downloadBlob(new Blob([submissionText(starter.notebook)], { type: 'application/x-ipynb+json' }), starter.name)
    } catch (err) {
      this.say(errorText(err), true)
    }
  }

  /** Fetch every submission and build one zip file in the browser. File names come from the students' names, made safe and unique. */
  private async downloadAll(): Promise<void> {
    if (this.busy) return
    this.busy = true
    const { assignment } = this.data
    const submitted = this.data.students.filter((s) => s.submittedAt !== null)
    const names = uniqueFileNames(submitted.map((s) => s.name), '.ipynb')
    const files: Record<string, Uint8Array> = {}
    try {
      for (let i = 0; i < submitted.length; i++) {
        this.say(`Fetching submission ${i + 1} of ${submitted.length}…`)
        const submission = await api.submission(assignment.id, submitted[i].id)
        if (!this.alive) return
        files[names[i]] = strToU8(submissionText(submission.notebook))
      }
      const zip = zipSync(files, { level: 6 })
      downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `${safeFileName(assignment.title, 'assignment')}-submissions.zip`)
      this.say(`Downloaded ${submitted.length} submission${submitted.length === 1 ? '' : 's'} as one zip file.`)
    } catch (err) {
      this.say(`The download stopped: ${errorText(err)}`, true)
    } finally {
      this.busy = false
    }
  }
}
