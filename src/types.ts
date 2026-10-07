export const AGENTS = ["cursor", "claude", "codex", "vscode", "gemini"] as const
export type Agent = (typeof AGENTS)[number]

// What a manifest writes to when it does not list its own agents.
export const DEFAULT_AGENTS: readonly Agent[] = ["cursor", "claude", "codex"]

export type Transport = "stdio" | "http" | "sse"

// Values may reference environment variables as ${NAME}. agentcfg rewrites
// them into each agent's own syntax when it writes a config.
export interface Server {
  transport: Transport
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  startupTimeoutSec?: number
  enabled?: boolean
}

export interface ManifestServer extends Server {
  agents?: Agent[]
}

export type ServerMap = Record<string, ManifestServer>

// The global manifest and each project manifest have the same shape.
export interface Manifest {
  $schema?: string
  version: 1
  // The agent files this manifest manages. Defaults to DEFAULT_AGENTS.
  agents?: Agent[]
  servers: ServerMap
}

export function isAgent(value: string): value is Agent {
  return (AGENTS as readonly string[]).includes(value)
}
