/** The few icons of the page, as inline SVG that takes the text colour. */
const PATHS = {
  play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none"/>',
  spinner: '<path d="M8 2a6 6 0 1 0 6 6" class="spin"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  down: '<path d="M8 3v10M4 9l4 4 4-4"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v3.5M9.2 7v3.5"/>',
  check: '<path d="M3 8.5l3.2 3.2L13 4.8"/>',
  cross: '<path d="M4 4l8 8M12 4l-8 8"/>',
  dot: '<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>',
  edit: '<path d="M3 13l.6-2.8L10.8 3l2.2 2.2-7.2 7.2zM9.5 4.3l2.2 2.2"/>',
  done: '<path d="M3 8.5l3.2 3.2L13 4.8"/>',
} as const

export type IconName = keyof typeof PATHS

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('icon', `icon-${name}`)
  // Static markup from the table above, never from a notebook.
  svg.innerHTML = PATHS[name]
  return svg
}
