import { join } from "node:path"

import { readCodexServers, upsertCodexMcp } from "./codex-toml.ts"
import { isRecord, readJson, readText, type Saver, updateJson, updateText } from "./files.ts"
import { type Context, locations } from "./paths.ts"
import { compact, fromJsonServer, mapStrings, toEnvVars } from "./servers.ts"
import type { Agent, Server, ServerMap } from "./types.ts"

export interface Entry {
  name: string
  server: Server
}

export interface WriteOptions {
  prune?: boolean
  backup?: Saver
}

export interface WriteResult {
  changed: boolean
  removed: string[]
}

// Everything agentcfg knows about one agent's config format.
export interface AgentAdapter {
  name: Agent
  globalFile: (ctx: Context) => string
  projectFile: (root: string) => string
  read: (file: string) => Promise<ServerMap>
  write: (file: string, entries: Entry[], options?: WriteOptions) => Promise<WriteResult>
  // The part of a server this format can hold. Diffing on anything more
  // would report drift that a sync can never fix.
  project: (server: Server) => Server
}

interface JsonAgentSpec {
  name: Agent
  key: string
  globalFile: (ctx: Context) => string
  projectFile: (root: string) => string
  encode: (server: Server) => Record<string, unknown>
  project: (server: Server) => Server
  // Normalizes one raw entry before the shared reader sees it.
  decode?: (raw: Record<string, unknown>) => Record<string, unknown>
}

function jsonAgent(spec: JsonAgentSpec): AgentAdapter {
  const decode = (raw: unknown) =>
    fromJsonServer(isRecord(raw) && spec.decode ? spec.decode(raw) : raw)
  return {
    name: spec.name,
    globalFile: spec.globalFile,
    projectFile: spec.projectFile,
    project: spec.project,
    async read(file) {
      const servers: ServerMap = {}
      const raw = (await readJson(file))[spec.key]
      if (!isRecord(raw)) return servers
      for (const [name, entry] of Object.entries(raw)) {
        const server = decode(entry)
        if (server) servers[name] = server
      }
      return servers
    },
    async write(file, entries, { prune = false, backup } = {}) {
      let removed: string[] = []
      const changed = await updateJson(
        file,
        (data) => {
          const existing = data[spec.key]
          const current = isRecord(existing) ? { ...existing } : {}
          const names = new Set(entries.map((entry) => entry.name))
          removed = prune ? Object.keys(current).filter((name) => !names.has(name)) : []
          for (const name of removed) delete current[name]
          for (const entry of entries) current[entry.name] = spec.encode(entry.server)
          return { ...data, [spec.key]: current }
        },
        backup
      )
      return { changed, removed: changed ? removed : [] }
    }
  }
}

// Remote servers keep their headers, local ones their env, and sse is folded
// into http for formats that only know one kind of URL.
function projection(server: Server, { sse, cwd }: { sse: boolean; cwd: boolean }): Server {
  const remote = server.transport !== "stdio"
  return compact({
    transport: !remote ? "stdio" : sse && server.transport === "sse" ? "sse" : "http",
    url: server.url,
    headers: remote ? server.headers : undefined,
    command: server.command,
    args: server.args,
    env: remote ? undefined : server.env,
    cwd: cwd && !remote ? server.cwd : undefined
  })
}

const cursor = jsonAgent({
  name: "cursor",
  key: "mcpServers",
  globalFile: (ctx) => locations(ctx).cursorMcp,
  projectFile: (root) => join(root, ".cursor", "mcp.json"),
  encode(server) {
    const out = mapStrings(server, toEnvVars)
    if (out.transport === "stdio")
      return compact({ command: out.command, args: out.args, env: out.env })
    return compact({ url: out.url, headers: out.headers })
  },
  project: (server) => projection(server, { sse: false, cwd: false })
})

const claude = jsonAgent({
  name: "claude",
  key: "mcpServers",
  globalFile: (ctx) => locations(ctx).claudeJson,
  projectFile: (root) => join(root, ".mcp.json"),
  encode(server) {
    if (server.transport === "stdio") {
      return compact({ command: server.command, args: server.args, env: server.env })
    }
    return compact({ type: server.transport, url: server.url, headers: server.headers })
  },
  project: (server) => projection(server, { sse: true, cwd: false })
})

const vscode = jsonAgent({
  name: "vscode",
  key: "servers",
  globalFile: (ctx) => locations(ctx).vscodeUser,
  projectFile: (root) => join(root, ".vscode", "mcp.json"),
  encode(server) {
    const out = mapStrings(server, toEnvVars)
    if (out.transport === "stdio") {
      return compact({
        type: "stdio",
        command: out.command,
        args: out.args,
        env: out.env,
        cwd: out.cwd
      })
    }
    return compact({ type: out.transport, url: out.url, headers: out.headers })
  },
  project: (server) => projection(server, { sse: true, cwd: true })
})

// Gemini CLI tells transports apart by key: httpUrl for streamable HTTP, url
// for SSE.
const gemini = jsonAgent({
  name: "gemini",
  key: "mcpServers",
  globalFile: (ctx) => locations(ctx).gemini,
  projectFile: (root) => join(root, ".gemini", "settings.json"),
  decode(raw) {
    if (typeof raw.httpUrl === "string") return { ...raw, url: raw.httpUrl, type: "http" }
    if (typeof raw.url === "string") return { ...raw, type: "sse" }
    return raw
  },
  encode(server) {
    if (server.transport === "stdio") {
      return compact({
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd
      })
    }
    const url = server.transport === "sse" ? { url: server.url } : { httpUrl: server.url }
    return compact({ ...url, headers: server.headers })
  },
  project: (server) => projection(server, { sse: true, cwd: true })
})

const codex: AgentAdapter = {
  name: "codex",
  globalFile: (ctx) => locations(ctx).codexConfig,
  projectFile: (root) => join(root, ".codex", "config.toml"),
  async read(file) {
    const text = await readText(file)
    return text ? readCodexServers(text, file) : {}
  },
  async write(file, entries, { prune = false, backup } = {}) {
    let removed: string[] = []
    const changed = await updateText(
      file,
      (text) => {
        const next = upsertCodexMcp(text ?? "", entries, { prune })
        removed = next.removed
        return next.text
      },
      backup
    )
    return { changed, removed: changed ? removed : [] }
  },
  project(server) {
    return compact({
      ...projection(server, { sse: false, cwd: true }),
      startupTimeoutSec: server.startupTimeoutSec,
      enabled: server.enabled === false ? false : undefined
    })
  }
}

export const ADAPTERS: Record<Agent, AgentAdapter> = { cursor, claude, codex, vscode, gemini }

export function adapter(agent: Agent): AgentAdapter {
  return ADAPTERS[agent]
}
