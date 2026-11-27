/**
 * The doodles the app shows (the landing page has its own, put into its HTML when the site is
 * built). They are files drawn by scripts/doodles.mjs; here they become inline SVG, so that they
 * take the ink colour and the pens of the theme. All of them are decoration: the text next to a
 * doodle says everything.
 */
import allDone from '../doodles/all-done.svg?raw'
import circle from '../doodles/circle.svg?raw'
import mark from '../doodles/mark.svg?raw'
import noAssignments from '../doodles/no-assignments.svg?raw'
import noCourses from '../doodles/no-courses.svg?raw'
import notFound from '../doodles/not-found.svg?raw'
import plane from '../doodles/plane.svg?raw'
import { el } from './dom.ts'

const DOODLES = { 'all-done': allDone, circle, mark, 'no-assignments': noAssignments, 'no-courses': noCourses, 'not-found': notFound, plane } as const

export type DoodleName = keyof typeof DOODLES

export function doodle(name: DoodleName): SVGSVGElement {
  const holder = document.createElement('template')
  // Static markup from this project's own files, never from a notebook.
  holder.innerHTML = DOODLES[name]
  return holder.content.firstElementChild as SVGSVGElement
}

/** "Nothing here yet": a doodle next to the sentence that says so. */
export function emptyState(name: DoodleName, text: string, className = ''): HTMLElement {
  return el('div', { class: `empty-state ${className}`.trim() }, [doodle(name), el('p', { class: 'empty' }, [text])])
}
