export const AGENTS = ["cursor", "claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];

export type Transport = "stdio" | "http" | "sse";

// Values may reference environment variables as ${NAME}. agentcfg rewrites
// them into each agent's own syntax when it writes a config.
export interface Server {
  transport: Transport;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  startupTimeoutSec?: number;
  enabled?: boolean;
}

export interface ManifestServer extends Server {
  agents?: Agent[];
}

export type ServerMap = Record<string, ManifestServer>;

// The global manifest and each project manifest have the same shape.
export interface Manifest {
  version: 1;
  servers: ServerMap;
}

export function isAgent(value: string): value is Agent {
  return (AGENTS as readonly string[]).includes(value);
}
