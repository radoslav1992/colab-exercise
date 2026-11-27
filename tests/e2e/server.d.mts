import type { DatabaseSync } from 'node:sqlite'
import type { HeaderRule } from '../../server/static.ts'
import type { ServerConfig } from '../../server/server.ts'

export function parseHeaders(text: string): HeaderRule[]
export function startServer(
  options: {
    root: string
    headersFile?: string
    port?: number
    extraFiles?: Record<string, string>
    /** false: a static site without an API. */
    api?: boolean
  } & Partial<Omit<ServerConfig, 'port' | 'site'>>,
): Promise<{ url: string; db?: DatabaseSync; close(): Promise<void> }>
