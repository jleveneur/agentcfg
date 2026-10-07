import { parse } from "smol-toml"

import { errorMessage, isRecord } from "./files.ts"
import { compact } from "./servers.ts"
import type { Server, ServerMap } from "./types.ts"

// Reading goes through a real TOML parser. Writing splices whole
// [mcp_servers.*] sections so the rest of config.toml keeps its formatting.

export function parseToml(text: string, file = "config.toml"): Record<string, unknown> {
  try {
    return parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid TOML: ${errorMessage(error)}`, { cause: error })
  }
}

export function readCodexServers(text: string, file?: string): ServerMap {
  const data = parseToml(text, file)
  const servers: ServerMap = {}
  if (!isRecord(data.mcp_servers)) return servers
  for (const [name, raw] of Object.entries(data.mcp_servers)) {
    const server = fromCodex(raw)
    if (server) servers[name] = server
  }
  return servers
}

export function fromCodex(raw: unknown): Server | null {
  if (!isRecord(raw)) return null
  const enabled = raw.enabled === false ? false : undefined
  if (typeof raw.url === "string") {
    return compact({
      transport: "http",
      url: raw.url,
      headers: codexHeaders(raw.http_headers, raw.env_http_headers, raw.bearer_token_env_var),
      enabled
    })
  }
  if (typeof raw.command === "string") {
    return compact({
      transport: "stdio",
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : undefined,
      env: codexEnv(raw.env, raw.env_vars),
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      startupTimeoutSec:
        typeof raw.startup_timeout_sec === "number" ? raw.startup_timeout_sec : undefined,
      enabled
    })
  }
  return null
}

interface Section {
  name: string
  lines: string[]
}

const HEADER = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(?:#.*)?$/

export function splitToml(text: string): { preamble: string[]; sections: Section[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const preamble: string[] = []
  const sections: Section[] = []
  let current: Section | null = null
  let multiline: string | null = null

  for (const line of lines) {
    const match = multiline ? null : line.match(HEADER)
    if (match?.[1]) {
      current = { name: match[1], lines: [line] }
      sections.push(current)
    } else if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
    multiline = trackMultiline(line, multiline)
  }
  return { preamble, sections }
}

// The server a section belongs to: `mcp_servers.docs`, `mcp_servers."my.server".env`.
export function mcpServerName(sectionName: string): string | null {
  const keys = splitDottedKey(sectionName)
  if (keys[0] !== "mcp_servers" || !keys[1]) return null
  return keys[1]
}

export function renderCodexServer(name: string, server: Server): string {
  const header = `mcp_servers.${tomlKey(name)}`
  const lines = [`[${header}]`]
  if (server.transport === "stdio") {
    lines.push(`command = ${tomlString(server.command ?? "")}`)
    if (server.args?.length) lines.push(`args = ${tomlArray(server.args)}`)
    const forwarded = Object.entries(server.env ?? {})
      .filter(([key, value]) => value === `\${${key}}`)
      .map(([key]) => key)
    if (forwarded.length) lines.push(`env_vars = ${tomlArray(forwarded)}`)
    if (server.cwd) lines.push(`cwd = ${tomlString(server.cwd)}`)
    if (server.startupTimeoutSec != null)
      lines.push(`startup_timeout_sec = ${server.startupTimeoutSec}`)
  } else {
    lines.push(`url = ${tomlString(server.url ?? "")}`)
    const literal: Record<string, string> = {}
    const fromEnv: Record<string, string> = {}
    let bearer: string | undefined
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      const variable = value.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1]
      const token =
        key.toLowerCase() === "authorization"
          ? value.match(/^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1]
          : undefined
      if (token) bearer = token
      else if (variable) fromEnv[key] = variable
      else literal[key] = value
    }
    if (bearer) lines.push(`bearer_token_env_var = ${tomlString(bearer)}`)
    if (Object.keys(literal).length) lines.push(`http_headers = ${tomlInlineTable(literal)}`)
    if (Object.keys(fromEnv).length) lines.push(`env_http_headers = ${tomlInlineTable(fromEnv)}`)
  }
  if (server.enabled === false) lines.push("enabled = false")

  const blocks = [lines.join("\n")]
  const literalEnv = Object.entries(server.env ?? {}).filter(
    ([key, value]) => value !== `\${${key}}`
  )
  if (server.transport === "stdio" && literalEnv.length) {
    const envLines = [`[${header}.env]`]
    for (const [key, value] of literalEnv) envLines.push(`${tomlKey(key)} = ${tomlString(value)}`)
    blocks.push(envLines.join("\n"))
  }
  return blocks.join("\n\n")
}

export interface CodexUpsert {
  text: string
  removed: string[]
}

export function upsertCodexMcp(
  text: string,
  servers: { name: string; server: Server }[],
  { prune = false }: { prune?: boolean } = {}
): CodexUpsert {
  const existing = text.trim() ? readCodexServers(text) : {}
  const { preamble, sections } = splitToml(text)
  const names = new Set(servers.map((entry) => entry.name))
  const removed = new Set<string>()
  const kept = sections.filter((section) => {
    const name = mcpServerName(section.name)
    if (!name) return true
    if (names.has(name)) return false
    const server = existing[name]
    if (prune && !(server && isManagedServer(server))) {
      removed.add(name)
      return false
    }
    return true
  })

  const extra = servers.map((entry) => renderCodexServer(entry.name, entry.server)).join("\n\n")
  return { text: joinToml(preamble, kept, extra), removed: [...removed] }
}

// Servers the Codex or ChatGPT app writes for itself. agentcfg never imports
// or prunes them.
export function isManagedServer(server: Server): boolean {
  const haystack = `${server.command ?? ""}\n${server.cwd ?? ""}`
  return /ChatGPT\.app|\/\.codex\/plugins\/|Computer Use\.app|Codex Computer Use/.test(haystack)
}

function joinToml(preamble: string[], sections: Section[], extra: string): string {
  const chunks: string[] = []
  const pre = preamble.join("\n").replace(/\s+$/, "")
  if (pre) chunks.push(pre)
  for (const section of sections) {
    const body = section.lines.join("\n").replace(/\s+$/, "")
    if (body) chunks.push(body)
  }
  if (extra) chunks.push(extra.replace(/\s+$/, ""))
  return chunks.length ? `${chunks.join("\n\n")}\n` : ""
}

// Tracks whether a line leaves a """ or ''' string open, so a `[` at the
// start of a line inside it is not taken for a section header.
function trackMultiline(line: string, open: string | null): string | null {
  let state = open
  let index = 0
  while (index < line.length) {
    if (state) {
      const end = line.indexOf(state, index)
      if (end === -1) return state
      index = end + 3
      state = null
      continue
    }
    const double = line.indexOf('"""', index)
    const single = line.indexOf("'''", index)
    const starts = [double, single].filter((position) => position !== -1)
    if (!starts.length) return null
    const start = Math.min(...starts)
    state = line.slice(start, start + 3)
    index = start + 3
  }
  return state
}

function splitDottedKey(key: string): string[] {
  const parts: string[] = []
  let index = 0
  while (index < key.length) {
    while (key[index] === " " || key[index] === "\t") index += 1
    const quote = key[index]
    if (quote === '"' || quote === "'") {
      let value = ""
      index += 1
      while (index < key.length && key[index] !== quote) {
        if (quote === '"' && key[index] === "\\") index += 1
        value += key[index] ?? ""
        index += 1
      }
      parts.push(value)
      index += 1
    } else {
      const end = key.indexOf(".", index)
      parts.push(key.slice(index, end === -1 ? undefined : end).trim())
      index = end === -1 ? key.length : end
    }
    while (key[index] === " " || key[index] === "\t") index += 1
    if (key[index] === ".") index += 1
  }
  return parts
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)
}

export function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`
}

function tomlArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`
}

function tomlInlineTable(record: Record<string, string>): string {
  return `{ ${Object.entries(record)
    .map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`)
    .join(", ")} }`
}

// Codex keeps literal headers, env-sourced headers, and the bearer token
// apart. The manifest writes them all as headers with ${VAR} references, like
// the JSON agents.
function codexHeaders(
  literal: unknown,
  fromEnv: unknown,
  bearer: unknown
): Record<string, string> | undefined {
  const headers = { ...stringRecord(literal) }
  if (typeof bearer === "string" && bearer) headers.Authorization = `Bearer \${${bearer}}`
  for (const [key, variable] of Object.entries(stringRecord(fromEnv) ?? {}))
    headers[key] = `\${${variable}}`
  return Object.keys(headers).length ? headers : undefined
}

// Codex forwards variables listed in env_vars from its own environment. The
// manifest spells that as NAME: "${NAME}".
function codexEnv(env: unknown, forwarded: unknown): Record<string, string> | undefined {
  const out = { ...stringRecord(env) }
  for (const name of Array.isArray(forwarded) ? forwarded : []) {
    if (typeof name === "string") out[name] = `\${${name}}`
  }
  return Object.keys(out).length ? out : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]))
}
