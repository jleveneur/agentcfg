export const AGENTS = ["cursor", "claude", "codex"] as const;
export type Agent = (typeof AGENTS)[number];

export type Transport = "stdio" | "http" | "sse";

export interface Server {
  transport: Transport;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  bearerTokenEnvVar?: string;
  startupTimeoutSec?: number;
  enabled?: boolean;
}

export interface ManifestServer extends Server {
  agents?: Agent[];
  scope?: "global" | "project";
}

export type ServerMap = Record<string, ManifestServer>;

export interface Manifest {
  version: 1;
  servers: ServerMap;
  projects: Record<string, ServerMap>;
}

export function isAgent(value: string): value is Agent {
  return (AGENTS as readonly string[]).includes(value);
}
