export interface HeaderRule {
  pattern: RegExp
  headers: Array<[string, string]>
}
export function parseHeaders(text: string): HeaderRule[]
export function startServer(options: {
  root: string
  headersFile?: string
  port?: number
  extraFiles?: Record<string, string>
}): Promise<{ url: string; close(): Promise<void> }>
