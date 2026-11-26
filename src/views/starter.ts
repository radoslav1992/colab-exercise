/** The teacher edits an assignment's starter notebook in the normal editor; it is saved on the server as they type. */
import { api, type User } from '../api.ts'
import { link } from '../router.ts'
import { remoteKey } from '../storage.ts'
import { el } from '../ui/dom.ts'
import type { View } from './notebook.ts'
import { RemoteNotebook } from './remote.ts'

export class StarterView implements View {
  readonly root: HTMLElement
  private readonly remote: RemoteNotebook
  private readonly title = el('h1', {}, ['Starter notebook'])
  private readonly note = el('p', { class: 'panel-meta' })
  private readonly crumbs = el('p', { class: 'crumbs' })

  constructor(
    user: User,
    private readonly assignmentId: string,
  ) {
    const panel = el('section', { class: 'assignment-panel' }, [this.crumbs, el('div', { class: 'panel-head' }, [this.title]), this.note])
    panel.setAttribute('aria-label', 'Starter notebook')
    this.remote = new RemoteNotebook(
      {
        key: remoteKey('starter', user.id, assignmentId),
        load: async () => {
          const starter = await api.starter(assignmentId)
          this.describe(starter.title, starter.state, starter.courseId)
          return starter
        },
        save: (text, version, name) => api.saveStarter(assignmentId, text, version, name),
        reader: 'students see',
      },
      {
        heading: 'Starter notebook',
        panel,
        canOpenFiles: true,
        savedWhere: 'The starter is saved on the server while you type.',
      },
    )
    this.root = this.remote.view.root
  }

  private describe(title: string, state: string, courseId: string): void {
    document.title = `Starter: ${title} · Notebook Lab`
    this.title.textContent = `Starter notebook: ${title}`
    this.crumbs.replaceChildren(
      link({ view: 'courses' }, 'My courses'),
      ' › ',
      link({ view: 'course', id: courseId }, 'Course'),
      ' › ',
      link({ view: 'assignment', id: this.assignmentId }, title),
    )
    this.note.textContent =
      state === 'draft'
        ? 'Each student gets their own copy of this notebook when they first open the assignment. Leave the solutions out: students receive exactly what is here.'
        : 'This assignment is published. Changes here reach only students who have not opened the assignment yet; everybody else keeps the copy they already have.'
  }

  start(): Promise<void> {
    return this.remote.start()
  }

  destroy(): void {
    this.remote.destroy()
  }
}
