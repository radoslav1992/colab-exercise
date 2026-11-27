/**
 * The slice of Cloudflare D1's API that the server uses. D1 provides it in production;
 * server/db.ts provides it over SQLite (node:sqlite) for local development and tests.
 * This file has no runtime imports, so the Worker bundle does not grow.
 */
import type { AssignmentState, Role } from '../shared/limits.ts'

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}

export interface SqlDb {
  prepare(sql: string): SqlStatement
  /** Run several statements as one transaction (D1's batch). */
  batch(statements: SqlStatement[]): Promise<unknown>
}

export interface UserRow {
  id: string
  email: string
  name: string
  role: Role
  password_hash: string
  created_at: number
}

export interface CourseRow {
  id: string
  owner_id: string
  name: string
  term: string
  description: string
  join_code: string
  join_open: number
  archived_at: number | null
  created_at: number
  updated_at: number
}

/** An assignment without its starter notebook. */
export interface AssignmentRow {
  id: string
  course_id: string
  title: string
  instructions: string
  due_at: number | null
  points: number | null
  state: AssignmentState
  published_at: number | null
  grades_released_at: number | null
  starter_name: string
  starter_version: number
  starter_updated_at: number
  created_at: number
  updated_at: number
}

export const ASSIGNMENT_COLUMNS =
  'id, course_id, title, instructions, due_at, points, state, published_at, grades_released_at, starter_name, starter_version, starter_updated_at, created_at, updated_at'
