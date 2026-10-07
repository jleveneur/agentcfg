import { basename, dirname, join, resolve } from "node:path"

import { adapter, type Entry } from "./agents.ts"
import { Backup } from "./backup.ts"
import { isManagedServer } from "./codex-toml.ts"
import { fileExists } from "./files.ts"
import {
  agentsFor,
  emptyManifest,
  manifestAgents,
  readManifest,
  readManifestOrEmpty,
  SCHEMA_URL,
  validateServer,
  writeManifest
} from "./manifest.ts"
import { type Context, findProjectManifest, locations, MANIFEST_NAME } from "./paths.ts"
import { sameServer, secretFields } from "./servers.ts"
import {
  type Agent,
  DEFAULT_AGENTS,
  isAgent,
  type Manifest,
  type ManifestServer,
  type Server,
  type ServerMap
} from "./types.ts"

export interface CommandOptions {
  ctx: Context
  // Directory to start from when looking for or creating a project manifest.
  dir: string
  global?: boolean
  manifest?: string
  agents?: string[]
  prefer?: string
  includeManaged?: boolean
  prune?: boolean
  dryRun?: boolean
  force?: boolean
}

// One manifest and the agent files it manages: the home configs for the
// global manifest, the project's files for a project manifest.
export interface Scope {
  kind: "global" | "project"
  label: string
  manifest: string
  root: string
}

export interface Conflict {
  name: string
  entries: { agent: Agent; server: Server }[]
}

export interface DiffRow {
  label: string
  agent: Agent
  name: string
  status: "same" | "missing" | "different" | "extra"
  managed?: boolean
  actual?: Server
  expected?: Server
}

export function targetFile(scope: Scope, agent: Agent, ctx: Context): string {
  const format = adapter(agent)
  return scope.kind === "global" ? format.globalFile(ctx) : format.projectFile(scope.root)
}

export function globalScope(options: CommandOptions): Scope {
  return {
    kind: "global",
    label: "global",
    manifest: resolve(options.manifest ?? locations(options.ctx).globalManifest),
    root: options.ctx.home
  }
}

export function projectScope(file: string): Scope {
  const root = dirname(file)
  return { kind: "project", label: basename(root), manifest: file, root }
}

export async function resolveScope(options: CommandOptions): Promise<Scope> {
  if (options.global) return globalScope(options)
  const file = options.manifest
    ? resolve(options.manifest)
    : await findProjectManifest(options.dir, options.ctx)
  if (!file) {
    throw new Error(
      `No ${MANIFEST_NAME} in ${options.dir} or its parents. Create one with "agentcfg init" or "agentcfg add NAME URL", or pass --global.`
    )
  }
  return projectScope(file)
}

// The manifest a write goes to: the global one, the nearest project one, or
// a new one in the current directory.
async function editableScope(options: CommandOptions): Promise<Scope> {
  if (options.global || options.manifest) return resolveScope(options)
  const found = await findProjectManifest(options.dir, options.ctx)
  return projectScope(found ?? join(resolve(options.dir), MANIFEST_NAME))
}

// Creates an empty manifest: the global one with --global, else one in the
// current directory.
export async function initManifest(options: CommandOptions) {
  const scope = options.global
    ? globalScope(options)
    : projectScope(resolve(options.manifest ?? join(options.dir, MANIFEST_NAME)))
  if ((await fileExists(scope.manifest)) && !options.force) {
    throw new Error(`${scope.manifest} already exists. Pass --force to start over.`)
  }
  const agents = options.agents?.length ? checkAgents(options.agents) : undefined
  const manifest = emptyManifest(
    agents && agents.join() !== DEFAULT_AGENTS.join() ? agents : undefined
  )
  if (!options.dryRun) await writeManifest(scope.manifest, manifest)
  return { scope, manifest }
}

// Reads the agent files of one scope into its manifest. A project import
// creates <dir>/agentcfg.json.
export async function importConfigs(options: CommandOptions) {
  if (options.prefer && !isAgent(options.prefer)) {
    throw new Error(`Unknown agent for --prefer: ${options.prefer}`)
  }
  const scope = options.global
    ? globalScope(options)
    : projectScope(resolve(options.manifest ?? join(options.dir, MANIFEST_NAME)))
  const existing = await readManifestOrEmpty(scope.manifest)
  if (Object.keys(existing.servers).length && !options.force) {
    throw new Error(`${scope.manifest} already lists servers. Pass --force to replace them.`)
  }
  const agents = options.agents?.length ? checkAgents(options.agents) : manifestAgents(existing)
  const warnings: string[] = []
  const conflicts: Conflict[] = []
  const servers = await collect(scope, agents, options, warnings, conflicts)
  const { agents: _previous, ...rest } = existing
  const manifest: Manifest = {
    ...rest,
    $schema: existing.$schema ?? SCHEMA_URL,
    ...(agents.join() === DEFAULT_AGENTS.join() ? {} : { agents }),
    servers
  }
  if (!options.dryRun) await writeManifest(scope.manifest, manifest)
  return { scope, manifest, warnings, conflicts }
}

export interface ServerSpec {
  name: string
  // A URL for a remote server, or a command and its arguments after `--`.
  url?: string
  command?: string[]
  transport?: string
  headers?: string[]
  env?: string[]
}

// Adds one server to the project manifest, creating it in the current
// directory when there is none, or to the global manifest with --global.
export async function addServer(options: CommandOptions, spec: ServerSpec) {
  if (!/^[A-Za-z0-9_.-]+$/.test(spec.name)) {
    throw new Error(`Server names use letters, digits, ".", "_" and "-": ${spec.name}`)
  }
  const server = buildServer(spec, options)
  const secrets = secretFields(server)
  if (secrets.length) {
    throw new Error(
      `Literal secret in ${secrets.join(", ")}. Write it as \${NAME} and set NAME in your environment.`
    )
  }

  const scope = await editableScope(options)
  const manifest = await readManifestOrEmpty(scope.manifest)
  validateServer(server, spec.name, manifestAgents(manifest))
  const current = manifest.servers[spec.name]
  if (current && !options.force) {
    const sameAgents = (current.agents ?? []).join() === (server.agents ?? []).join()
    if (sameServer(current, server) && sameAgents) return { scope, status: "unchanged" as const }
    throw new Error(`${spec.name} is already in ${scope.manifest}. Pass --force to replace it.`)
  }
  manifest.servers[spec.name] = server
  if (!options.dryRun) await writeManifest(scope.manifest, manifest)
  return { scope, status: current ? ("replaced" as const) : ("added" as const) }
}

export async function removeServer(options: CommandOptions, name: string) {
  const scope = await resolveScope(options)
  const manifest = await readManifest(scope.manifest)
  if (!manifest.servers[name]) throw new Error(`${name} is not in ${scope.manifest}`)
  delete manifest.servers[name]
  if (!options.dryRun) await writeManifest(scope.manifest, manifest)
  return { scope }
}

export async function diffConfigs(options: CommandOptions) {
  const scope = await resolveScope(options)
  const manifest = await readManifest(scope.manifest)
  return { scope, rows: await diffScope(scope, manifest, options) }
}

export async function syncConfigs(options: CommandOptions) {
  const scope = await resolveScope(options)
  const manifest = await readManifest(scope.manifest)
  const rows = await diffScope(scope, manifest, options)
  if (options.dryRun) return { scope, rows, wrote: [], removed: [], backup: null }

  const backup = new Backup(locations(options.ctx).stateDir)
  const wrote: string[] = []
  const removed: string[] = []
  // One file per agent, written in turn so a failure leaves the rest alone.
  for (const agent of selectedAgents(options, manifest)) {
    const file = targetFile(scope, agent, options.ctx)
    const entries: Entry[] = Object.entries(manifest.servers)
      .filter(([, server]) => agentsFor(server, manifest).includes(agent))
      .map(([name, server]) => ({ name, server: withoutAgents(server) }))
    // oxlint-disable-next-line no-await-in-loop
    if (!entries.length && !(options.prune && (await fileExists(file)))) continue
    // oxlint-disable-next-line no-await-in-loop
    const result = await adapter(agent).write(file, entries, { prune: options.prune, backup })
    if (result.changed) wrote.push(file)
    removed.push(...result.removed.map((name) => `${agent} ${name}`))
  }
  return { scope, rows, wrote, removed, backup: backup.saved.length ? backup : null }
}

async function collect(
  scope: Scope,
  agents: Agent[],
  options: CommandOptions,
  warnings: string[],
  conflicts: Conflict[]
): Promise<ServerMap> {
  const found = new Map<string, { agent: Agent; server: Server }[]>()
  const read = await Promise.all(
    agents.map(async (agent) => ({
      agent,
      servers: await adapter(agent).read(targetFile(scope, agent, options.ctx))
    }))
  )
  for (const { agent, servers } of read) {
    for (const [name, server] of Object.entries(servers)) {
      if (!options.includeManaged && isManagedServer(server)) {
        warnings.push(`${scope.label} ${agent}: skipped ${name} (managed by the agent app)`)
        continue
      }
      const secrets = secretFields(server)
      if (secrets.length) {
        warnings.push(
          `${scope.label} ${agent}: skipped ${name} (literal secret in ${secrets.join(", ")})`
        )
        continue
      }
      found.set(name, [...(found.get(name) ?? []), { agent, server }])
    }
  }

  const servers: ServerMap = {}
  for (const [name, entries] of [...found.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    const [first] = entries
    if (!first) continue
    // Compare what every format can hold. Codex-only fields such as
    // startup_timeout_sec are merged in rather than reported as conflicts.
    const conflict = entries.some(
      (entry) => !sameServer(common(entry.server), common(first.server))
    )
    if (conflict && !options.prefer) {
      conflicts.push({ name, entries })
      continue
    }
    const chosen = entries.find((entry) => entry.agent === options.prefer)?.server ?? first.server
    // The chosen definition wins, and the other agents fill in fields it lacks.
    const merged = entries
      .map((entry) => entry.server)
      .toReversed()
      .reduce<Server>((acc, server) => Object.assign(acc, server), { ...chosen })
    Object.assign(merged, chosen)
    const from = [...new Set(entries.map((entry) => entry.agent))]
    servers[name] = from.length === agents.length ? merged : { ...merged, agents: from }
  }
  return servers
}

// What every agent format can hold.
function common(server: Server): Server {
  return adapter("cursor").project(server)
}

async function diffScope(
  scope: Scope,
  manifest: Manifest,
  options: CommandOptions
): Promise<DiffRow[]> {
  const agents = selectedAgents(options, manifest)
  const actual = await Promise.all(
    agents.map((agent) => adapter(agent).read(targetFile(scope, agent, options.ctx)))
  )
  const rows: DiffRow[] = []
  for (const [index, agent] of agents.entries()) {
    const current = actual[index] ?? {}
    const format = adapter(agent)
    const label = scope.label
    const expectedNames = new Set<string>()
    for (const [name, server] of Object.entries(manifest.servers)) {
      if (!agentsFor(server, manifest).includes(agent)) continue
      expectedNames.add(name)
      const existing = current[name]
      const expected = format.project(server)
      if (!existing) rows.push({ label, agent, name, status: "missing" })
      else if (sameServer(format.project(existing), expected)) {
        rows.push({ label, agent, name, status: "same" })
      } else rows.push({ label, agent, name, status: "different", actual: existing, expected })
    }
    for (const [name, server] of Object.entries(current)) {
      if (expectedNames.has(name)) continue
      rows.push({ label, agent, name, status: "extra", managed: isManagedServer(server) })
    }
  }
  return rows
}

function buildServer(spec: ServerSpec, options: CommandOptions): ManifestServer {
  const agents = options.agents?.length ? checkAgents(options.agents) : undefined
  const env = pairs(spec.env, "=", "--env")
  const headers = pairs(spec.headers, ":", "--header")

  let server: ManifestServer
  const [command, ...args] = spec.command ?? []
  if (command) {
    if (spec.url) throw new Error("Give either a URL or a command after --, not both.")
    if (headers) throw new Error("--header only applies to remote servers.")
    server = {
      transport: "stdio",
      command,
      ...(args.length ? { args } : {}),
      ...(env ? { env } : {})
    }
  } else if (spec.url) {
    if (env) throw new Error("--env only applies to commands. Remote servers take --header.")
    const transport = spec.transport ?? "http"
    if (transport !== "http" && transport !== "sse") {
      throw new Error(`--transport is http or sse, not ${transport}`)
    }
    server = { transport, url: spec.url, ...(headers ? { headers } : {}) }
  } else {
    throw new Error(
      "Give a URL (agentcfg add NAME URL) or a command (agentcfg add NAME -- COMMAND ARGS...)."
    )
  }
  return agents ? { ...server, agents } : server
}

function pairs(
  values: string[] | undefined,
  separator: string,
  flag: string
): Record<string, string> | undefined {
  if (!values?.length) return undefined
  const out: Record<string, string> = {}
  for (const value of values) {
    const at = value.indexOf(separator)
    if (at <= 0) {
      throw new Error(`${flag} expects KEY${separator === ":" ? ": " : "="}VALUE, got ${value}`)
    }
    out[value.slice(0, at).trim()] = value.slice(at + 1).trim()
  }
  return out
}

function withoutAgents(server: ManifestServer): Server {
  const { agents: _agents, ...rest } = server
  return rest
}

function checkAgents(values: string[]): Agent[] {
  const agents: Agent[] = []
  for (const value of values) {
    if (!isAgent(value)) throw new Error(`Unknown agent: ${value}`)
    agents.push(value)
  }
  return agents
}

// The agents a diff or sync touches: those the manifest manages, narrowed by
// --agent.
function selectedAgents(options: CommandOptions, manifest: Manifest): Agent[] {
  const managed = manifestAgents(manifest)
  if (!options.agents?.length) return managed
  const agents = checkAgents(options.agents)
  const outside = agents.filter((agent) => !managed.includes(agent))
  if (outside.length) {
    throw new Error(
      `${outside.join(", ")} is not managed by this manifest. Add it to "agents" first; it manages ${managed.join(", ")}.`
    )
  }
  return agents
}
