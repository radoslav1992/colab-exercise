export function parseJsonc(text: string): unknown
export function startWorker(options: { repo: string; assets: string; database?: boolean; vars?: Record<string, string>; log?: boolean }): Promise<{
  url: string
  migration: string
  configFile: string
  state: string
  output(): string
  close(): Promise<void>
  resetLink(email: string): Promise<string>
}>
