/** One course: for its teacher (join code, assignments, students, settings) and for a student (assignments, leave). */
import { formatJoinCode, LIMITS } from '../../shared/limits.ts'
import { api, type StudentCourseView, type TeacherCourseView } from '../api.ts'
import { fitNotebook } from '../notebook/fit.ts'
import { MAX_NOTEBOOK_BYTES } from '../../shared/limits.ts'
import { parseNotebook } from '../notebook/ipynb.ts'
import { secrets } from '../runtime/token.ts'
import { link, navigate } from '../router.ts'
import { loadSample, samples } from '../samples.ts'
import { currentDocId, loadDoc } from '../storage.ts'
import { confirmDialog } from '../ui/confirm.ts'
import { button, el, field, formatDate, formatDateTime, formatNumber, fromLocalInput, messageBox, uid } from '../ui/dom.ts'
import { setFlash } from '../ui/flash.ts'
import { describeDropped } from '../notebook/fit.ts'
import { badge, crumbs, errorText, Page, table } from './page.ts'

/** The notebook that is open in the playground of this browser: its autosaved copy, or the sample as it ships. */
async function playgroundNotebook(): Promise<{ name: string; text: string }> {
  const id = currentDocId()
  const saved = id ? loadDoc(id) : null
  if (saved) return { name: saved.name, text: saved.text }
  const file = id?.startsWith('sample:') && samples.some((s) => `sample:${s.file}` === id) ? id.slice('sample:'.length) : samples[0].file
  return { name: file, text: await loadSample(file) }
}

function playgroundName(): string {
  const id = currentDocId()
  const saved = id ? loadDoc(id) : null
  if (saved) return saved.name
  return id?.startsWith('sample:') ? id.slice('sample:'.length) : samples[0].file
}

export class CourseView extends Page {
  constructor(private readonly id: string) {
    super()
    void this.refresh()
  }

  protected async load(): Promise<Array<Node | null>> {
    const data = await api.course(this.id)
    document.title = `${data.course.name} · Notebook Lab`
    return data.role === 'teacher' ? this.teacher(data) : this.student(data)
  }

  private head(course: { name: string; term: string; description: string; archived: boolean }, extra = ''): Node[] {
    return [
      crumbs([[{ view: 'courses' }, 'My courses']]),
      el('div', { class: 'page-head' }, [el('h1', {}, [course.name]), course.archived ? badge('archived') : null]),
      el('p', { class: 'page-meta' }, [[course.term, extra].filter(Boolean).join(' · ')]),
      course.description ? el('p', { class: 'description' }, [course.description]) : null,
    ].filter((node): node is HTMLElement => node !== null)
  }

  // --- Student --------------------------------------------------------------------------------------

  private student(data: StudentCourseView): Array<Node | null> {
    const { course, assignments } = data
    const rows = assignments.map((a) => [
      link({ view: 'assignment', id: a.id }, a.title),
      a.dueAt !== null ? formatDateTime(a.dueAt) : 'No due date',
      el('span', {}, [badge(a.status), a.state === 'closed' ? badge('closed') : null]),
      a.graded ? (a.grade === null ? 'See feedback' : a.points !== null ? `${formatNumber(a.grade)} of ${formatNumber(a.points)}` : formatNumber(a.grade)) : '',
    ])
    const leave = button(
      'Leave course',
      () =>
        void confirmDialog({
          title: `Leave ${course.name}?`,
          body: [
            'This deletes your work, your submissions and your grades in this course from the server. It cannot be undone. Download the notebooks you want to keep first.',
          ],
          confirm: 'Leave and delete my work',
          danger: true,
          run: () => api.leaveCourse(course.id).then(() => undefined),
        }).then((left) => {
          if (!left) return
          setFlash(`You left ${course.name}.`)
          navigate({ view: 'courses' })
        }),
      'button danger',
    )
    return [
      ...this.head(course, `Teacher: ${course.teacher}`),
      el('section', { class: 'page-section' }, [
        el('h2', {}, ['Assignments']),
        assignments.length > 0
          ? table('Assignments', ['Assignment', 'Due', 'Status', 'Grade'], rows)
          : el('p', { class: 'empty' }, ['No assignments yet. They appear here when your teacher publishes them.']),
      ]),
      el('section', { class: 'page-section' }, [el('h2', {}, ['Leave']), el('p', {}, ['Leaving removes you from the course and deletes your work in it.']), leave]),
    ]
  }

  // --- Teacher --------------------------------------------------------------------------------------

  private teacher(data: TeacherCourseView): Array<Node | null> {
    const { course, roster, assignments } = data

    // Join code
    const code = el('output', { class: 'join-code' }, [formatJoinCode(course.joinCode)])
    code.setAttribute('aria-label', `Join code ${course.joinCode.split('').join(' ')}`)
    const copy = button('Copy', () => {
      void navigator.clipboard?.writeText(formatJoinCode(course.joinCode)).then(
        () => this.say('Join code copied.'),
        () => this.say('The code could not be copied. Select it and copy it by hand.', true),
      )
    })
    const renew = button('New code', () => {
      void confirmDialog({
        title: 'Make a new join code?',
        body: ['The code above stops working at once. Students who already joined stay in the course.'],
        confirm: 'Make a new code',
        run: () => api.newJoinCode(course.id).then(() => undefined),
      }).then((ok) => ok && this.act(async () => {}, 'New join code made. The old one no longer works.'))
    })
    const toggle = button(course.joinOpen ? 'Switch joining off' : 'Switch joining on', () => {
      void this.act(() => api.updateCourse(course.id, { joinOpen: !course.joinOpen }), course.joinOpen ? 'Joining is switched off.' : 'Joining is switched on.')
    })
    const joinState = course.archived
      ? 'This course is archived, so nobody can join.'
      : course.joinOpen
        ? 'Students join with this code on their "My courses" page. Anybody who has the code can join, so share it with your class only.'
        : 'Joining is switched off: the code does not work until you switch it on again.'
    const join = el('section', { class: 'page-section' }, [
      el('h2', {}, ['Join code']),
      el('div', { class: 'join-box' }, [code, el('div', { class: 'form-buttons' }, [copy, renew, toggle])]),
      el('p', { class: 'field-help' }, [joinState]),
    ])
    join.dataset.joinOpen = String(course.joinOpen && !course.archived)

    // Assignments
    const assignmentRows = assignments.map((a) => [
      link({ view: 'assignment', id: a.id }, a.title),
      badge(a.state),
      a.dueAt !== null ? formatDateTime(a.dueAt) : 'No due date',
      `${a.submitted} of ${roster.length}`,
      `${a.graded}${a.gradesReleased ? ', released' : ''}`,
    ])
    const newAssignment = course.archived ? null : el('details', { class: 'disclosure', open: assignments.length === 0 }, [el('summary', {}, ['New assignment']), this.assignmentForm(course.id)])
    const assignmentSection = el('section', { class: 'page-section' }, [
      el('h2', {}, ['Assignments']),
      assignments.length > 0
        ? table('Assignments', ['Assignment', 'State', 'Due', 'Submitted', 'Graded'], assignmentRows)
        : el('p', { class: 'empty' }, ['No assignments yet. An assignment is a notebook that every student gets their own copy of.']),
      newAssignment,
    ])

    // Students
    const rosterRows = roster.map((s) => [
      s.name,
      s.email,
      formatDate(s.joinedAt),
      button(
        'Remove',
        () =>
          void confirmDialog({
            title: `Remove ${s.name} from the course?`,
            body: [
              `This deletes the work, the submissions and the grades of ${s.name} in this course. It cannot be undone. Download their submissions first if you need them.`,
              'They can join again with the join code, but they start from the beginning.',
            ],
            confirm: 'Remove and delete their work',
            danger: true,
            run: () => api.removeStudent(course.id, s.id).then(() => undefined),
          }).then((ok) => ok && this.act(async () => {}, `${s.name} was removed from the course.`)),
        'button small danger',
      ),
    ])
    const students = el('section', { class: 'page-section' }, [
      el('h2', {}, [`Students (${roster.length})`]),
      roster.length > 0 ? table('Students', ['Name', 'Email', 'Joined', 'Remove'], rosterRows, 'roster') : el('p', { class: 'empty' }, ['Nobody has joined yet.']),
    ])

    // Settings
    const name = field('Course name', el('input', { type: 'text', maxLength: LIMITS.courseName, value: course.name }))
    const term = field('Term (optional)', el('input', { type: 'text', maxLength: LIMITS.term, value: course.term }))
    const description = field('Description (optional)', el('textarea', { rows: 3, maxLength: LIMITS.description, value: course.description }))
    const error = messageBox('error')
    const settingsForm = el('form', { class: 'card-form', noValidate: true }, [name.row, term.row, description.row, error, el('div', { class: 'form-buttons' }, [el('button', { type: 'submit', class: 'button primary' }, ['Save'])])])
    settingsForm.addEventListener('submit', (event) => {
      event.preventDefault()
      void this.act(() => api.updateCourse(course.id, { name: name.input.value, term: term.input.value, description: description.input.value }), 'Course saved.')
    })
    const archive = button(course.archived ? 'Bring the course back' : 'Archive course', () => {
      void this.act(() => api.updateCourse(course.id, { archived: !course.archived }), course.archived ? 'The course is active again.' : 'The course is archived.')
    })
    const remove = button(
      'Delete course',
      () =>
        void confirmDialog({
          title: `Delete ${course.name}?`,
          body: [
            `This deletes the course, its ${assignments.length} assignment${assignments.length === 1 ? '' : 's'} and, for all ${roster.length} student${roster.length === 1 ? '' : 's'}, their work, submissions and grades in this course. It cannot be undone.`,
            'To keep the course for reference, archive it instead.',
          ],
          confirm: 'Delete the course',
          danger: true,
          run: () => api.deleteCourse(course.id).then(() => undefined),
        }).then((ok) => {
          if (!ok) return
          setFlash(`${course.name} was deleted.`)
          navigate({ view: 'courses' })
        }),
      'button danger',
    )
    const settings = el('section', { class: 'page-section' }, [
      el('h2', {}, ['Settings']),
      el('details', { class: 'disclosure' }, [el('summary', {}, ['Name, term and description']), settingsForm]),
      el('p', { class: 'field-help' }, [
        course.archived
          ? 'Archived: nobody can join, add assignments or submit. Everything stays readable.'
          : 'Archiving ends the course: nobody can join, add assignments or submit, and everything stays readable.',
      ]),
      el('div', { class: 'form-buttons' }, [archive, remove]),
    ])

    return [...this.head(course, `${roster.length} student${roster.length === 1 ? '' : 's'}`), join, assignmentSection, students, settings]
  }

  /** The form for a new assignment: its fields and where the starter notebook comes from. */
  private assignmentForm(courseId: string): HTMLElement {
    const title = field('Title', el('input', { type: 'text', maxLength: LIMITS.title, required: true }))
    const instructions = field('Instructions (Markdown, optional)', el('textarea', { rows: 4, maxLength: LIMITS.instructions }), 'Shown to students above their notebook.')
    const due = field('Due date and time (optional)', el('input', { type: 'datetime-local' }), 'In your time zone. Students see it in theirs. Submissions after it are marked late.')
    const pointsField = field('Points (optional)', el('input', { type: 'number', min: '0', max: String(LIMITS.maxPoints), step: '0.01', inputMode: 'decimal' }))

    const group = uid('source')
    const radio = (value: string, checked = false) => el('input', { type: 'radio', name: group, value, id: uid('source-option'), checked })
    const fromFile = radio('file', true)
    const fromSample = radio('sample')
    const fromPlayground = radio('playground')
    const fromEmpty = radio('empty')
    const file = el('input', { type: 'file', accept: '.ipynb,application/x-ipynb+json,application/json' })
    file.setAttribute('aria-label', 'Notebook file')
    const sample = el('select', {}, samples.map((s) => new Option(s.title, s.file)))
    sample.setAttribute('aria-label', 'Sample notebook')
    file.addEventListener('change', () => (fromFile.checked = true))
    sample.addEventListener('change', () => (fromSample.checked = true))
    const source = el('fieldset', { class: 'field choice' }, [
      el('legend', {}, ['Starter notebook']),
      el('div', { class: 'choice-row' }, [el('label', { htmlFor: fromFile.id }, [fromFile, ' Upload a .ipynb file']), file]),
      el('div', { class: 'choice-row' }, [el('label', { htmlFor: fromSample.id }, [fromSample, ' Start from a sample']), sample]),
      el('div', { class: 'choice-row' }, [el('label', { htmlFor: fromPlayground.id }, [fromPlayground, ` The notebook open in the playground (${playgroundName()})`])]),
      el('div', { class: 'choice-row' }, [el('label', { htmlFor: fromEmpty.id }, [fromEmpty, ' An empty notebook'])]),
      el('p', { class: 'field-help' }, ['Students get exactly this notebook, so leave the solutions out. You can edit it before you publish.']),
    ])

    const error = messageBox('error')
    const create = el('button', { type: 'submit', class: 'button primary' }, ['Create draft'])
    const form = el('form', { class: 'card-form', noValidate: true }, [title.row, instructions.row, due.row, pointsField.row, source, error, el('div', { class: 'form-buttons' }, [create])])

    const starter = async (): Promise<{ name: string; text: string } | null> => {
      if (fromEmpty.checked) return null
      if (fromFile.checked) {
        const chosen = file.files?.[0]
        if (!chosen) throw new Error('Choose a .ipynb file, or pick another starter.')
        return { name: chosen.name, text: await chosen.text() }
      }
      if (fromSample.checked) return { name: sample.value, text: await loadSample(sample.value) }
      return playgroundNotebook()
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      error.textContent = ''
      const fail = (message: string, focus?: HTMLElement) => {
        error.textContent = message
        focus?.focus()
      }
      if (!title.input.value.trim()) return fail('Give the assignment a title.', title.input)
      const dueAt = fromLocalInput(due.input.value)
      if (due.input.value && dueAt === null) return fail('The due date is not a valid date and time.', due.input)
      const pointsText = pointsField.input.value.trim()
      const points = pointsText === '' ? null : Number(pointsText)
      if (points !== null && (!Number.isFinite(points) || points < 0 || points > LIMITS.maxPoints)) return fail(`Points must be a number from 0 to ${LIMITS.maxPoints}.`, pointsField.input)
      create.disabled = true
      void (async () => {
        try {
          // Read and check the notebook first, so that a bad file does not leave an empty draft behind.
          const chosen = await starter()
          const fit = chosen ? fitNotebook(parseNotebook(chosen.text), MAX_NOTEBOOK_BYTES, secrets()) : null
          if (fit && !fit.fits) throw new Error('This notebook is larger than 1 MB even without its pictures and sound. Clear its outputs and try again.')
          const created = await api.createAssignment(courseId, { title: title.input.value, instructions: instructions.input.value, dueAt, points })
          let note = 'Draft created. Students do not see it until you publish it.'
          if (chosen && fit) {
            try {
              await api.saveStarter(created.id, fit.text, created.starterVersion, chosen.name)
              if (fit.dropped.length > 0) note += ` The starter was stored without ${describeDropped(fit.dropped)}, because a stored notebook is limited to 1 MB.`
            } catch (err) {
              note = `Draft created, but the starter notebook could not be stored (${errorText(err)}). Use "Replace with a file" below.`
            }
          }
          setFlash(note)
          navigate({ view: 'assignment', id: created.id })
        } catch (err) {
          create.disabled = false
          fail(errorText(err))
        }
      })()
    })
    return form
  }
}
