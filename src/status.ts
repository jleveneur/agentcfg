import { execFile } from "node:child_process"

import { isManagedServer, parseToml } from "./codex-toml.ts"
import { type CommandOptions, globalScope, projectScope } from "./commands.ts"
import { errorMessage, isRecord, readText } from "./files.ts"
import { agentsFor, MissingManifest, readManifest } from "./manifest.ts"
import { findProjectManifest, locations } from "./paths.ts"
import type { Agent, Manifest } from "./types.ts"

// The agents whose CLI can report on their own servers.
export const STATUS_AGENTS = ["cursor", "claude", "codex"] as const
export type StatusAgent = (typeof STATUS_AGENTS)[number]

export type State =
  | "ready"
  | "configured"
  | "needs-login"
  | "needs-approval"
  | "disabled"
  | "failed"
  | "missing"
  | "untrusted"
  | "unknown"

export interface ServerState {
  state: State
  detail: string
}

export interface Parsed {
  servers: Record<string, ServerState>
  // claude.ai connectors that Claude Code loads from the account.
  connectors: string[]
  managed: string[]
}

export interface CliReport extends Parsed {
  agent: StatusAgent
  available: boolean
  error?: string
}

export interface StatusRow {
  name: string
  from: "global" | "project"
  cells: Partial<Record<StatusAgent, ServerState>>
}

export interface StatusReport {
  dir: string
  project: string | null
  rows: StatusRow[]
  others: { agent: StatusAgent; name: string; status: ServerState }[]
  connectors: string[]
  reports: CliReport[]
  codexTrusted: boolean | null
}

const CLI: Record<StatusAgent, { command: string; args: string[]; parse(text: string): Parsed }> = {
  claude: { command: "claude", args: ["mcp", "list"], parse: parseClaude },
  cursor: { command: "cursor-agent", args: ["mcp", "list"], parse: parseCursor },
  codex: { command: "codex", args: ["mcp", "list", "--json"], parse: parseCodex }
}

// `name: target - ✔ Connected`, one server per line, claude.ai connectors
// prefixed with "claude.ai ".
export function parseClaude(text: string): Parsed {
  const out: Parsed = { servers: {}, connectors: [], managed: [] }
  for (const line of text.split("\n")) {
    const match = line.match(/^(.+?): .* - (.+)$/)
    if (!match?.[1] || !match[2]) continue
    const [, name, raw] = match
    if (name.startsWith("claude.ai ")) {
      out.connectors.push(name.slice("claude.ai ".length))
      continue
    }
    const detail = raw.replace(/^[^\p{L}]+/u, "").trim()
    out.servers[name] = { state: claudeState(detail), detail }
  }
  return out
}

function claudeState(detail: string): State {
  if (/connected/i.test(detail) && !/failed/i.test(detail)) return "ready"
  if (/auth/i.test(detail)) return "needs-login"
  if (/approval/i.test(detail)) return "needs-approval"
  if (/disabled/i.test(detail)) return "disabled"
  if (/failed|error/i.test(detail)) return "failed"
  return "unknown"
}

// `name: ready`, `name: requires_authentication`, `name: not loaded (needs approval)`.
export function parseCursor(text: string): Parsed {
  const out: Parsed = { servers: {}, connectors: [], managed: [] }
  for (const line of text.split("\n")) {
    const match = line.match(/^([^\s:][^:]*): (.+)$/)
    if (!match?.[1] || !match[2]) continue
    const detail = match[2].trim()
    out.servers[match[1]] = { state: cursorState(detail), detail }
  }
  return out
}

function cursorState(detail: string): State {
  if (/^ready|connected/i.test(detail)) return "ready"
  if (/auth/i.test(detail)) return "needs-login"
  if (/approval/i.test(detail)) return "needs-approval"
  if (/disabled/i.test(detail)) return "disabled"
  if (/error|fail/i.test(detail)) return "failed"
  return "unknown"
}

// Codex lists its config without connecting, so the best it can say is
// whether a server is enabled and logged in.
export function parseCodex(text: string): Parsed {
  const out: Parsed = { servers: {}, connectors: [], managed: [] }
  const data: unknown = JSON.parse(text)
  if (!Array.isArray(data)) return out
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue
    const transport = isRecord(entry.transport) ? entry.transport : {}
    const command = typeof transport.command === "string" ? transport.command : undefined
    const cwd = typeof transport.cwd === "string" ? transport.cwd : undefined
    if (isManagedServer({ transport: "stdio", command, cwd })) out.managed.push(entry.name)
    const auth = typeof entry.auth_status === "string" ? entry.auth_status : ""
    if (entry.enabled === false) out.servers[entry.name] = { state: "disabled", detail: "disabled" }
    else if (auth === "not_logged_in") {
      out.servers[entry.name] = { state: "needs-login", detail: "not logged in" }
    } else out.servers[entry.name] = { state: "configured", detail: auth || "configured" }
  }
  return out
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ available: boolean; stdout: string; error?: string }>((done) => {
    execFile(
      command,
      args,
      { cwd, env, timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          done({ available: true, stdout })
          return
        }
        const code = isRecord(error) ? error.code : undefined
        if (code === "ENOENT") done({ available: false, stdout: "" })
        else done({ available: true, stdout, error: (stderr || errorMessage(error)).trim() })
      }
    )
  })
}

async function report(agent: StatusAgent, dir: string, env: NodeJS.ProcessEnv): Promise<CliReport> {
  const cli = CLI[agent]
  const result = await run(cli.command, cli.args, dir, env)
  const empty = { servers: {}, connectors: [], managed: [] }
  if (!result.available) return { agent, available: false, ...empty }
  try {
    return { agent, available: true, ...cli.parse(result.stdout), error: result.error }
  } catch (error) {
    return { agent, available: true, ...empty, error: errorMessage(error) }
  }
}

async function optionalManifest(file: string): Promise<Manifest | null> {
  try {
    return await readManifest(file)
  } catch (error) {
    if (error instanceof MissingManifest) return null
    throw error
  }
}

export async function collectStatus(
  options: CommandOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<StatusReport> {
  const projectFile = await findProjectManifest(options.dir, options.ctx)
  const project = projectFile ? projectScope(projectFile) : null
  const dir = project?.root ?? options.dir
  const [global, local, ...reports] = await Promise.all([
    optionalManifest(globalScope(options).manifest),
    projectFile ? optionalManifest(projectFile) : null,
    ...STATUS_AGENTS.map((agent) => report(agent, dir, env))
  ])
  const codexTrusted = project ? await isCodexTrusted(options, project.root) : null

  const rows: StatusRow[] = []
  const expected = new Set<string>()
  const sources: [StatusRow["from"], Manifest | null][] = [
    ["global", global],
    ["project", local]
  ]
  for (const [from, manifest] of sources) {
    if (!manifest) continue
    for (const [name, server] of Object.entries(manifest.servers)) {
      expected.add(name)
      const agents: Agent[] = agentsFor(server, manifest)
      const cells: StatusRow["cells"] = {}
      for (const cli of reports) {
        if (!agents.includes(cli.agent)) continue
        cells[cli.agent] = cellFor(cli, name, from, codexTrusted)
      }
      rows.push({ name, from, cells })
    }
  }

  const others: StatusReport["others"] = []
  for (const cli of reports) {
    for (const [name, status] of Object.entries(cli.servers)) {
      if (!expected.has(name) && !cli.managed.includes(name)) {
        others.push({ agent: cli.agent, name, status })
      }
    }
  }
  const connectors = reports.flatMap((cli) => cli.connectors)
  return { dir, project: project?.root ?? null, rows, others, connectors, reports, codexTrusted }
}

function cellFor(
  cli: CliReport,
  name: string,
  from: StatusRow["from"],
  codexTrusted: boolean | null
): ServerState {
  if (!cli.available) return { state: "unknown", detail: "CLI not installed" }
  const found = cli.servers[name]
  if (found) return found
  if (cli.agent === "codex" && from === "project" && codexTrusted === false) {
    return { state: "untrusted", detail: "project not trusted" }
  }
  if (cli.error) return { state: "unknown", detail: cli.error.split("\n")[0] ?? cli.error }
  return { state: "missing", detail: "not loaded" }
}

// Codex reads .codex/config.toml only in projects marked trusted.
async function isCodexTrusted(options: CommandOptions, root: string): Promise<boolean> {
  const file = locations(options.ctx).codexConfig
  const text = await readText(file)
  if (!text) return false
  const projects = parseToml(text, file).projects
  if (!isRecord(projects)) return false
  const entry = projects[root]
  return isRecord(entry) && entry.trust_level === "trusted"
}
