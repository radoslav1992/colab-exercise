/** Home for somebody who is signed in: the courses they teach and the courses they are in. */
import { formatJoinCode, LIMITS } from '../../shared/limits.ts'
import { api, type EnrolledCourse, type TeachingCourse, type User } from '../api.ts'
import { link, navigate } from '../router.ts'
import { el, field, messageBox } from '../ui/dom.ts'
import { emptyState } from '../ui/doodle.ts'
import { setFlash } from '../ui/flash.ts'
import { badge, errorText, Page } from './page.ts'

export class CoursesView extends Page {
  constructor(private readonly user: User) {
    super()
    document.title = 'My courses · Notebook Lab'
    void this.refresh()
  }

  protected async load(): Promise<Array<Node | null>> {
    const { teaching, enrolled } = await api.courses()
    // With no course at all, the part that comes first gets the drawing of an empty notebook.
    const none = teaching.length === 0 && enrolled.length === 0
    const teacherFirst = this.user.role === 'teacher'
    const teachingSection = this.teaching(teaching, none && teacherFirst)
    const enrolledSection = this.enrolled(enrolled, none && !teacherFirst)
    // The role chosen at sign-up only decides which part comes first.
    const sections = teacherFirst ? [teachingSection, enrolledSection] : [enrolledSection, teachingSection]
    return [el('h1', {}, ['My courses']), ...sections]
  }

  private card(id: string, name: string, term: string, archived: boolean, facts: string[]): HTMLElement {
    const node = el('li', { class: 'course-card' }, [
      el('h3', {}, [link({ view: 'course', id }, name), archived ? badge('archived') : null]),
      el('p', { class: 'card-meta' }, [[term, ...facts].filter(Boolean).join(' · ')]),
    ])
    // The colour of the spine: one of four pens, always the same one for a course.
    node.dataset.pen = String([...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4)
    return node
  }

  private empty(text: string, drawn: boolean): HTMLElement {
    return drawn ? emptyState('no-courses', text) : el('p', { class: 'empty' }, [text])
  }

  private teaching(courses: TeachingCourse[], drawn: boolean): HTMLElement {
    const name = field('Course name', el('input', { type: 'text', maxLength: LIMITS.courseName, required: true }))
    const term = field('Term (optional)', el('input', { type: 'text', maxLength: LIMITS.term }), 'For example "Autumn 2026".')
    const description = field('Description (optional)', el('textarea', { rows: 3, maxLength: LIMITS.description }))
    const error = messageBox('error')
    const create = el('button', { type: 'submit', class: 'button primary' }, ['Create course'])
    const form = el('form', { class: 'card-form', noValidate: true }, [name.row, term.row, description.row, error, el('div', { class: 'form-buttons' }, [create])])
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      error.textContent = ''
      if (!name.input.value.trim()) {
        error.textContent = 'Give the course a name.'
        name.input.focus()
        return
      }
      create.disabled = true
      api.createCourse({ name: name.input.value, term: term.input.value, description: description.input.value }).then(
        ({ id }) => {
          setFlash('Course created. Give your students the join code below.')
          navigate({ view: 'course', id })
        },
        (err: unknown) => {
          create.disabled = false
          error.textContent = errorText(err)
        },
      )
    })
    const details = el('details', { class: 'disclosure', open: courses.length === 0 && this.user.role === 'teacher' }, [el('summary', {}, ['New course']), form])
    return el('section', { class: 'page-section' }, [
      el('h2', {}, ['Courses you teach']),
      courses.length > 0
        ? el(
            'ul',
            { class: 'course-list' },
            courses.map((c) =>
              this.card(c.id, c.name, c.term, c.archived, [
                `${c.students} student${c.students === 1 ? '' : 's'}`,
                `${c.assignments} assignment${c.assignments === 1 ? '' : 's'}`,
              ]),
            ),
          )
        : this.empty('You do not teach a course yet. Create one, and you get a join code to hand to your students.', drawn),
      details,
    ])
  }

  private enrolled(courses: EnrolledCourse[], drawn: boolean): HTMLElement {
    const code = field('Join code', el('input', { type: 'text', autocomplete: 'off', spellcheck: false, maxLength: 20, placeholder: formatJoinCode('ABCDEFGH') }), 'The 8 letters and digits your teacher gave you.')
    code.input.classList.add('code-input')
    const error = messageBox('error')
    const join = el('button', { type: 'submit', class: 'button primary' }, ['Join course'])
    const form = el('form', { class: 'card-form join-form', noValidate: true }, [code.row, error, el('div', { class: 'form-buttons' }, [join])])
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      error.textContent = ''
      if (!code.input.value.trim()) {
        error.textContent = 'Enter the join code.'
        code.input.focus()
        return
      }
      join.disabled = true
      api.joinCourse(code.input.value).then(
        ({ id, already }) => {
          setFlash(already ? 'You are already in this course.' : 'You joined the course.')
          navigate({ view: 'course', id })
        },
        (err: unknown) => {
          join.disabled = false
          error.textContent = errorText(err)
          code.input.focus()
        },
      )
    })
    return el('section', { class: 'page-section' }, [
      el('h2', {}, ['Courses you are in']),
      courses.length > 0
        ? el(
            'ul',
            { class: 'course-list' },
            courses.map((c) =>
              this.card(c.id, c.name, c.term, c.archived, [
                c.teacher,
                `${c.assignments} assignment${c.assignments === 1 ? '' : 's'}`,
                c.todo > 0 ? `${c.todo} to submit` : '',
              ]),
            ),
          )
        : this.empty('You are not in a course yet. Join one with the code from your teacher.', drawn),
      el('h3', { class: 'form-title' }, ['Join a course']),
      form,
    ])
  }
}
