/** One message that survives a change of view: "Assignment created", shown at the top of the next page. */
let pending = ''

export function setFlash(message: string): void {
  pending = message
}

/** The waiting message, once. */
export function takeFlash(): string {
  const message = pending
  pending = ''
  return message
}
