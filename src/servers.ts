import { basename } from "node:path"

import { isRecord } from "./files.ts"
import type { Server, ServerMap } from "./types.ts"

// Reads one server entry from any JSON-based config: Cursor, Claude Code,
// Claude Desktop, VS Code, Windsurf, Gemini, and plugin .mcp.json files.
export function fromJsonServer(raw: unknown): Server | null {
  if (!isRecord(raw)) return null
  const server = readJsonServer(raw)
  return server && mapStrings(server, fromEnvVars)
}

function readJsonServer(raw: Record<string, unknown>): Server | null {
  const enabled = raw.disabled === true || raw.enabled === false ? false : undefined
  const url = firstString(raw.url, raw.serverUrl, raw.httpUrl)
  if (url) {
    return compact({
      transport: raw.type === "sse" ? "sse" : "http",
      url,
      headers: stringRecord(raw.headers),
      enabled
    })
  }
  if (typeof raw.command === "string") {
    return compact({
      transport: "stdio",
      command: raw.command,
      args: stringArray(raw.args),
      env: stringRecord(raw.env),
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      enabled
    })
  }
  return null
}

export function fromJsonServers(raw: unknown): ServerMap {
  const servers: ServerMap = {}
  if (!isRecord(raw)) return servers
  for (const [name, entry] of Object.entries(raw)) {
    const server = fromJsonServer(entry)
    if (server) servers[name] = server
  }
  return servers
}

// Cursor and VS Code only expand ${env:NAME}, plus a few names of their own
// such as ${workspaceFolder}. Claude Code, Gemini, and the manifest use ${NAME}.
const EDITOR_BUILTINS = new Set([
  "userHome",
  "workspaceFolder",
  "workspaceFolderBasename",
  "pathSeparator"
])

export function toEnvVars(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    EDITOR_BUILTINS.has(name) ? match : `\${env:${name}}`
  )
}

function fromEnvVars(value: string): string {
  return value.replace(
    /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name: string) => `\${${name}}`
  )
}

export function mapStrings(server: Server, map: (value: string) => string): Server {
  const record = (value?: Record<string, string>) =>
    value && Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, map(entry)]))
  return compact({
    ...server,
    url: server.url && map(server.url),
    command: server.command && map(server.command),
    args: server.args?.map(map),
    env: record(server.env),
    headers: record(server.headers)
  })
}

export function signature(server: Server): string {
  return JSON.stringify({
    transport: server.transport,
    url: server.url ?? null,
    command: server.command ?? null,
    args: server.args ?? [],
    env: sortKeys(server.env),
    headers: sortKeys(server.headers),
    enabled: server.enabled !== false,
    cwd: server.cwd ?? null,
    startupTimeoutSec: server.startupTimeoutSec ?? null
  })
}

export function sameServer(left: Server, right: Server): boolean {
  return signature(left) === signature(right)
}

// A key that says "this is the same MCP server" even when two configs spell
// it differently: tracking query params dropped, `npx -y pkg@latest` and
// `pnpm dlx pkg` folded together.
export function identity(server: Server): string {
  if (server.url) return normalizeUrl(server.url)
  const tokens = [server.command ?? "", ...(server.args ?? [])]
  const runner = basename(tokens[0] ?? "")
  let rest: string[] | null = null
  if (["npx", "bunx", "pnpx"].includes(runner)) rest = tokens.slice(1)
  else if (["pnpm", "yarn", "bun"].includes(runner) && ["dlx", "x"].includes(tokens[1] ?? ""))
    rest = tokens.slice(2)
  else if (runner === "uvx") rest = tokens.slice(1)
  if (rest) {
    const [pkg = "", ...after] = dropLeadingFlags(rest)
    return ["pkg:" + stripVersion(pkg), ...after].join(" ").trim()
  }
  return [runner, ...tokens.slice(1)].join(" ").trim()
}

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key)
    }
    url.hash = ""
    url.username = ""
    url.password = ""
    const path = url.pathname.replace(/\/+$/, "")
    const query = url.searchParams.toString()
    return `${url.protocol}//${url.host.toLowerCase()}${path}${query ? `?${query}` : ""}`
  } catch {
    return raw
  }
}

export function secretFields(server: Server): string[] {
  const fields: string[] = []
  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (isLiteralSecret(value)) fields.push(`env.${key}`)
  }
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (isLiteralSecret(value)) fields.push(`headers.${key}`)
  }
  return fields
}

// A value is safe to store when its secret part comes from a variable:
// `${TOKEN}`, `$TOKEN`, or `Bearer ${TOKEN}`.
export function isLiteralSecret(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return false
  if (!/\$\{(env:)?[A-Za-z_][A-Za-z0-9_]*\}/.test(value)) return true
  const rest = value.replace(/\$\{(env:)?[A-Za-z_][A-Za-z0-9_]*\}/g, "").trim()
  return !["", "Bearer", "Token", "Basic"].includes(rest)
}

const SECRET_NAME = /key|token|secret|passw|auth|bearer|cookie|sig/i
export const REDACTED = "<redacted>"

// Safe to print or write to a report: env and header values, credential-like
// query params and arguments are masked unless they reference a variable.
function mask(record?: Record<string, string>): Record<string, string> | undefined {
  return (
    record &&
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, isLiteralSecret(value) ? REDACTED : value])
    )
  )
}

export function redact(server: Server): Server {
  return compact({
    ...server,
    url: server.url && redactUrl(server.url),
    env: mask(server.env),
    headers: mask(server.headers),
    args: server.args && redactArgs(server.args)
  })
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.username || url.password) {
      url.username = REDACTED
      url.password = ""
    }
    for (const key of Array.from(url.searchParams.keys())) {
      if (SECRET_NAME.test(key)) url.searchParams.set(key, REDACTED)
    }
    return url.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED)
  } catch {
    return raw
  }
}

function redactArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    const inline = arg.match(/^(--?[\w-]+)=(.*)$/)
    if (inline && SECRET_NAME.test(inline[1] ?? "") && isLiteralSecret(inline[2]))
      return `${inline[1]}=${REDACTED}`
    const previous = args[index - 1]
    if (
      previous &&
      /^--?[\w-]+$/.test(previous) &&
      SECRET_NAME.test(previous) &&
      isLiteralSecret(arg)
    )
      return REDACTED
    if (/^(sk|pk|rk|ghp|gho|github_pat|xox[abp]|glpat)[-_][A-Za-z0-9_-]{8,}/.test(arg))
      return REDACTED
    return arg
  })
}

function dropLeadingFlags(tokens: string[]): string[] {
  let index = 0
  while (index < tokens.length && tokens[index]?.startsWith("-")) index += 1
  return tokens.slice(index)
}

function stripVersion(pkg: string): string {
  const at = pkg.lastIndexOf("@")
  return at > 0 ? pkg.slice(0, at) : pkg.replace(/==.*$/, "")
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0)
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]))
}

function sortKeys(record?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record ?? {}).toSorted(([a], [b]) => a.localeCompare(b)))
}

export function compact<const T extends Record<string, unknown>>(value: T): T {
  // Dropping empty fields keeps every declared field's type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) =>
        entry != null &&
        !(Array.isArray(entry) && entry.length === 0) &&
        !(isRecord(entry) && Object.keys(entry).length === 0)
    )
  ) as T
}
