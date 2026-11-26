/**
 * Limits and small rules that the server enforces and the page explains. One file, imported by
 * both sides, so that a message on the page never names a number the server does not use.
 */

/** A stored notebook (starter, working copy, submission) as compact JSON, in UTF-8 bytes. D1 rejects values over 2 MB. */
export const MAX_NOTEBOOK_BYTES = 1_000_000
/** The request that carries a notebook may be a little larger than the notebook (whitespace). */
export const MAX_NOTEBOOK_BODY_BYTES = 1_300_000
export const MAX_NOTEBOOK_CELLS = 2_000

export const LIMITS = {
  /** Courses one person may own (archived ones count). */
  coursesPerTeacher: 30,
  /** Courses one person may be a student in. */
  coursesPerStudent: 50,
  studentsPerCourse: 300,
  assignmentsPerCourse: 60,
  name: 80,
  courseName: 100,
  term: 60,
  description: 2_000,
  title: 150,
  instructions: 20_000,
  feedback: 10_000,
  fileName: 100,
  /** Points and grades are numbers from 0 to this, with at most two decimals. */
  maxPoints: 10_000,
  passwordMin: 8,
  passwordMax: 200,
} as const

export type Role = 'teacher' | 'student'
export type AssignmentState = 'draft' | 'published' | 'closed'
/** What the teacher's table shows for one student. */
export type StudentStatus = 'not-started' | 'in-progress' | 'submitted' | 'late'

/** Join codes: 8 characters without the look-alikes 0/O, 1/I/L. */
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const JOIN_CODE_LENGTH = 8

/** What a person types or pastes, as the code that is stored: upper case, no spaces or dashes. */
export function normalizeJoinCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/g, '')
}

export function isJoinCode(code: string): boolean {
  if (code.length !== JOIN_CODE_LENGTH) return false
  for (const char of code) if (!JOIN_CODE_ALPHABET.includes(char)) return false
  return true
}

/** "ABCDEFGH" as "ABCD-EFGH", easier to read out. */
export function formatJoinCode(code: string): string {
  return code.length === JOIN_CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

/** The header that carries the per-session secret (see README, "Security model"). */
export const SESSION_HEADER = 'x-session-secret'
