import { readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve, sep } from "node:path"

import { isManagedServer, parseToml, readCodexServers } from "./codex-toml.ts"
import { type CursorInstalls, type CursorState, readCursorState } from "./cursor-state.ts"
import { errorMessage, fileExists, isRecord, readJson, readText } from "./files.ts"
import { type Context, discoverProjects, type Locations, locations } from "./paths.ts"
import { fromJsonServers, identity, redact } from "./servers.ts"
import type { Server, ServerMap } from "./types.ts"

export type Scope = "user" | "local" | "project" | "plugin"

export interface Finding {
  agent: string
  scope: Scope
  name: string
  file: string
  project?: string
  plugin?: string
  enabled: boolean
  managed?: boolean
  // Cursor workspaces whose last session loaded this server.
  loadedIn?: string[]
  // Cursor plugins: "everywhere" for a user install, or the projects that
  // turn the plugin on.
  installedIn?: string[]
  // Another agent that loads this server too, such as Cursor importing
  // Claude Code plugins.
  alsoLoadedBy?: string[]
  server: Server
}

// A server Cursor loaded that no file on disk defines any more: one added by
// an IDE extension, or one removed from its config since.
export interface LoadedOnly {
  id: string
  name: string
  origin: "user" | "project" | "plugin" | "extension"
  workspaces: string[]
  // When Cursor last wrote this server into a workspace's snapshot.
  lastSeen: string
  // Cursor last loaded it before its config file changed or its plugin went
  // away: a leftover in a workspace not opened since, not a live server.
  stale: boolean
}

export interface ScanResult {
  findings: Finding[]
  loadedOnly: LoadedOnly[]
  projects: string[]
  warnings: string[]
}

export interface ScanOptions {
  ctx: Context
  projects?: string | null
  cwd?: string
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const paths = locations(options.ctx)
  const findings: Finding[] = []
  const warnings: string[] = []

  const add = (
    base: Omit<Finding, "name" | "server" | "enabled"> & { enabled?: boolean },
    servers: ServerMap
  ) => {
    for (const [name, server] of Object.entries(servers)) {
      findings.push({
        ...base,
        name,
        enabled: base.enabled !== false && server.enabled !== false,
        managed: isManagedServer(server) || undefined,
        server: redact(server)
      })
    }
  }
  const safely = async (label: string, task: () => Promise<void>) => {
    try {
      await task()
    } catch (error) {
      warnings.push(`${label}: ${errorMessage(error)}`)
    }
  }

  // User-level files.
  await safely("cursor", async () =>
    add(
      { agent: "cursor", scope: "user", file: paths.cursorMcp },
      await jsonServers(paths.cursorMcp)
    )
  )
  let claudeJson: Record<string, unknown> = {}
  try {
    claudeJson = await readJson(paths.claudeJson)
  } catch (error) {
    warnings.push(`claude: ${errorMessage(error)}`)
  }
  add(
    { agent: "claude", scope: "user", file: paths.claudeJson },
    fromJsonServers(claudeJson.mcpServers)
  )
  const claudeProjects = isRecord(claudeJson.projects) ? claudeJson.projects : {}
  for (const [project, config] of Object.entries(claudeProjects)) {
    if (!isRecord(config)) continue
    add(
      { agent: "claude", scope: "local", project, file: paths.claudeJson },
      fromJsonServers(config.mcpServers)
    )
  }

  let codexConfig: Record<string, unknown> = {}
  await safely("codex", async () => {
    const text = await readText(paths.codexConfig)
    if (!text) return
    codexConfig = parseToml(text, paths.codexConfig)
    add(
      { agent: "codex", scope: "user", file: paths.codexConfig },
      readCodexServers(text, paths.codexConfig)
    )
  })

  await safely("claude-desktop", async () =>
    add(
      { agent: "claude-desktop", scope: "user", file: paths.claudeDesktop },
      await jsonServers(paths.claudeDesktop)
    )
  )
  await safely("vscode", async () =>
    add(
      { agent: "vscode", scope: "user", file: paths.vscodeUser },
      await jsonServers(paths.vscodeUser, "servers")
    )
  )
  await safely("devin", async () =>
    add({ agent: "devin", scope: "user", file: paths.devin }, await jsonServers(paths.devin))
  )
  await safely("windsurf", async () =>
    add(
      { agent: "windsurf", scope: "user", file: paths.windsurf },
      await jsonServers(paths.windsurf)
    )
  )
  await safely("gemini", async () =>
    add({ agent: "gemini", scope: "user", file: paths.gemini }, await jsonServers(paths.gemini))
  )

  // Project files. Projects come from --projects, the current directory, and
  // the projects Claude Code and Codex already know about.
  const codexProjects = isRecord(codexConfig.projects) ? Object.keys(codexConfig.projects) : []
  let cursorState: CursorState | null = null
  try {
    cursorState = await readCursorState(paths.cursorState)
  } catch (error) {
    warnings.push(`cursor: ${errorMessage(error)}`)
  }
  // The home directory is not a project: its .cursor/mcp.json is the user file.
  const projects = (
    await existingDirs([
      ...(await discoverProjects(options.projects)),
      ...(options.cwd ? [options.cwd] : []),
      ...Object.keys(claudeProjects),
      ...codexProjects,
      // Cursor also records the temporary folders other tools open it in.
      ...(cursorState?.workspaces ?? []).filter((dir) => !isTemporary(dir, options.ctx.home))
    ])
  ).filter((dir) => dir !== resolve(options.ctx.home))
  const cursorProjectPlugins = new Map<string, string[]>()
  for (const project of projects) {
    const files: [string, string, string, string?][] = [
      ["cursor", ".cursor/mcp.json", "json"],
      ["claude", ".mcp.json", "json"],
      ["codex", ".codex/config.toml", "toml"],
      ["vscode", ".vscode/mcp.json", "json", "servers"],
      ["gemini", ".gemini/settings.json", "json"]
    ]
    for (const [agent, relative, format, key] of files) {
      const file = join(project, relative)
      await safely(file, async () => {
        const servers =
          format === "toml"
            ? readCodexServers((await readText(file)) ?? "", file)
            : await jsonServers(file, key)
        add({ agent, scope: "project", project, file }, servers)
      })
    }
    const settings = await readJsonOrEmpty(join(project, ".cursor", "settings.json"))
    if (isRecord(settings.plugins)) {
      for (const [plugin, config] of Object.entries(settings.plugins)) {
        if (isRecord(config) && config.enabled === true) {
          cursorProjectPlugins.set(plugin, [...(cursorProjectPlugins.get(plugin) ?? []), project])
        }
      }
    }
  }

  // Plugins.
  await safely("claude plugins", async () => {
    const installed = await readJson(paths.claudePlugins)
    const settings = await readJson(paths.claudeSettings)
    const enabledPlugins = isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {}
    for (const [key, installs] of Object.entries(
      isRecord(installed.plugins) ? installed.plugins : {}
    )) {
      for (const install of Array.isArray(installs) ? installs : []) {
        if (!isRecord(install) || typeof install.installPath !== "string") continue
        const project = typeof install.projectPath === "string" ? install.projectPath : undefined
        for (const { file, servers } of await pluginServers(
          install.installPath,
          ".claude-plugin"
        )) {
          add(
            {
              agent: "claude",
              scope: "plugin",
              plugin: key,
              project,
              file,
              enabled: enabledPlugins[key] === true
            },
            servers
          )
        }
      }
    }
  })

  await safely("codex plugins", async () => {
    const plugins = isRecord(codexConfig.plugins) ? codexConfig.plugins : {}
    for (const [key, config] of Object.entries(plugins)) {
      const [name, marketplace] = key.split("@")
      if (!name || !marketplace) continue
      const dir = await newestChild(join(paths.codexPlugins, marketplace, name))
      if (!dir) continue
      const enabled = !(isRecord(config) && config.enabled === false)
      for (const { file, servers } of await pluginServers(dir, ".codex-plugin")) {
        add({ agent: "codex", scope: "plugin", plugin: key, file, enabled }, servers)
      }
    }
  })

  const cursorInstalls = cursorState?.installs ?? null
  const cachedPlugins: CursorPlugin[] = []
  await safely("cursor plugins", async () => {
    const plugins = await cursorPlugins(paths.cursorPlugins)
    cachedPlugins.push(...plugins)
    const known = new Set(plugins.flatMap((plugin) => plugin.ids))
    for (const plugin of plugins) {
      const installedIn = cursorInstallsFor(plugin, cursorInstalls, cursorProjectPlugins)
      for (const { file, servers } of await pluginServers(plugin.dir, ".cursor-plugin")) {
        add(
          {
            agent: "cursor",
            scope: "plugin",
            plugin: plugin.name,
            file,
            installedIn: installedIn ?? undefined,
            enabled: installedIn ? installedIn.length > 0 : undefined
          },
          servers
        )
      }
    }
    const unknown = cursorInstalls?.user.filter((id) => !known.has(id)) ?? []
    if (unknown.length) {
      warnings.push(
        `cursor: ${unknown.length} installed plugin${unknown.length === 1 ? " is" : "s are"} not in the local cache (ids ${unknown.join(", ")}). Open Cursor once to download them.`
      )
    }
  })

  // Cursor loads Claude Code's plugins too, through its default-on
  // "Include Third-Party Plugins" setting.
  if (await fileExists(paths.cursorDir)) {
    for (const finding of findings) {
      if (finding.agent === "claude" && finding.scope === "plugin" && finding.enabled) {
        finding.alsoLoadedBy = ["cursor"]
      }
    }
  }

  // What Cursor actually loaded, per workspace. Temporary folders, such as
  // the ones other tools open Cursor in, are left out.
  const slugs = new Map(projects.map((project) => [cursorSlug(project), project]))
  const loaded = await cursorLoaded(paths.cursorProjects, new Set(slugs.keys()))
  const place = (slug: string) => slugs.get(slug) ?? slug
  const matched = new Set<string>()
  for (const finding of findings) {
    if (finding.agent !== "cursor") continue
    const id = cursorServerId(finding)
    const seen = loaded.get(id)?.seen
    if (seen) matched.add(id)
    finding.loadedIn = (seen ?? []).map((entry) => place(entry.slug))
    // Without Cursor's own install record, fall back on what it loaded.
    if (finding.scope === "plugin" && !finding.installedIn) {
      const enabledBy = cursorProjectPlugins.get(finding.plugin ?? "") ?? []
      finding.enabled = finding.enabled && (finding.loadedIn.length > 0 || enabledBy.length > 0)
    }
  }
  const loadedOnly: LoadedOnly[] = []
  for (const [id, entry] of loaded) {
    if (matched.has(id) || id.startsWith("cursor-")) continue
    const origin = id.includes("-extension-")
      ? "extension"
      : id.startsWith("plugin-")
        ? "plugin"
        : id.startsWith("project-")
          ? "project"
          : "user"
    const lastSeen = Math.max(...entry.seen.map((item) => item.mtime))
    const changed = await definitionChanged(id, origin, { paths, projects, plugins: cachedPlugins })
    loadedOnly.push({
      id,
      name: entry.name,
      origin,
      workspaces: entry.seen.map((item) => place(item.slug)),
      lastSeen: new Date(lastSeen).toISOString(),
      stale: changed != null && changed > lastSeen
    })
  }

  return {
    findings,
    loadedOnly: loadedOnly.toSorted((a, b) => a.id.localeCompare(b.id)),
    projects,
    warnings
  }
}

export interface Group {
  identity: string
  names: string[]
  findings: Finding[]
}

export function groupFindings(findings: Finding[]): Group[] {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const key = identity(finding.server)
    groups.set(key, [...(groups.get(key) ?? []), finding])
  }
  return [...groups.entries()]
    .map(([key, list]) => ({
      identity: key,
      names: [...new Set(list.map((finding) => finding.name))],
      findings: list
    }))
    .toSorted(
      (a, b) => b.findings.length - a.findings.length || a.identity.localeCompare(b.identity)
    )
}

async function jsonServers(file: string, key = "mcpServers"): Promise<ServerMap> {
  const data = await readJson(file)
  return fromJsonServers(data[key])
}

// A plugin declares its servers in <manifestDir>/plugin.json, inline or as a
// path, or ships them in .mcp.json or mcp.json at its root.
async function pluginServers(
  dir: string,
  manifestDir: string
): Promise<{ file: string; servers: ServerMap }[]> {
  for (const manifest of [join(dir, manifestDir, "plugin.json"), join(dir, "plugin.json")]) {
    const data = await readJsonOrEmpty(manifest)
    const declared = data.mcpServers
    if (declared == null) continue
    const refs =
      typeof declared === "string"
        ? [declared]
        : Array.isArray(declared)
          ? declared.map(String)
          : null
    if (!refs) return [{ file: manifest, servers: fromJsonServers(declared) }]
    const out = []
    for (const ref of refs) {
      const file = resolve(dir, ref)
      out.push({ file, servers: serverMapFrom(await readJson(file)) })
    }
    return out
  }
  for (const name of [".mcp.json", "mcp.json"]) {
    const file = join(dir, name)
    if (await fileExists(file)) return [{ file, servers: serverMapFrom(await readJson(file)) }]
  }
  return []
}

function serverMapFrom(data: Record<string, unknown>): ServerMap {
  return fromJsonServers(isRecord(data.mcpServers) ? data.mcpServers : data)
}

// Cursor caches plugins as <marketplace>/<id or name>/<commit>/. Several
// commits of one plugin can sit side by side; the newest one wins.
interface CursorPlugin {
  name: string
  dir: string
  // Cursor's numeric ids for this plugin, from cache folders named by id.
  ids: string[]
}

async function cursorPlugins(cacheDir: string): Promise<CursorPlugin[]> {
  const newest = new Map<string, { dir: string; mtime: number }>()
  const ids = new Map<string, Set<string>>()
  for (const marketplace of await childDirs(cacheDir)) {
    for (const entry of await childDirs(marketplace)) {
      for (const dir of await childDirs(entry)) {
        if (!(await readdir(dir)).length) continue
        const manifest = {
          ...(await readJsonOrEmpty(join(dir, "plugin.json"))),
          ...(await readJsonOrEmpty(join(dir, ".cursor-plugin", "plugin.json")))
        }
        const name = typeof manifest.name === "string" ? manifest.name : basename(entry)
        if (/^\d+$/.test(basename(entry))) {
          ids.set(name, (ids.get(name) ?? new Set()).add(basename(entry)))
        }
        const mtime = (await stat(dir)).mtimeMs
        const current = newest.get(name)
        if (!current || mtime > current.mtime) newest.set(name, { dir, mtime })
      }
    }
  }
  return [...newest.entries()].map(([name, { dir }]) => ({
    name,
    dir,
    ids: [...(ids.get(name) ?? [])]
  }))
}

// Where Cursor turns a plugin on: everywhere when the user installed it, and
// in each project whose .cursor/settings.json enables it or whose workspace
// record lists it. Null when Cursor's record could not be read.
function cursorInstallsFor(
  plugin: CursorPlugin,
  installs: CursorInstalls | null,
  byProjectSettings: Map<string, string[]>
): string[] | null {
  if (!installs) return null
  const out = new Set<string>()
  if (plugin.ids.some((id) => installs.user.includes(id))) out.add("everywhere")
  for (const project of byProjectSettings.get(plugin.name) ?? []) out.add(project)
  for (const [workspace, entries] of Object.entries(installs.workspaces)) {
    if (entries.some((entry) => entry.fromProject && plugin.ids.includes(entry.id)))
      out.add(workspace)
  }
  return [...out]
}

interface Loaded {
  name: string
  seen: { slug: string; mtime: number }[]
}

// Cursor rewrites ~/.cursor/projects/<workspace>/mcps each time it opens the
// workspace, one folder per server it loaded.
async function cursorLoaded(projectsDir: string, known: Set<string>): Promise<Map<string, Loaded>> {
  const loaded = new Map<string, Loaded>()
  const workspaces = (await childDirs(projectsDir)).filter(
    (dir) => known.has(basename(dir)) || !isTemporarySlug(basename(dir))
  )
  const servers = await Promise.all(
    workspaces.map(async (workspace) => {
      const dirs = await childDirs(join(workspace, "mcps"))
      return Promise.all(
        dirs.map(async (dir) => ({
          workspace,
          dir,
          meta: await readJsonOrEmpty(join(dir, "SERVER_METADATA.json")),
          mtime: (await stat(dir)).mtimeMs
        }))
      )
    })
  )
  for (const { workspace, dir, meta, mtime } of servers.flat()) {
    const id = typeof meta.serverIdentifier === "string" ? meta.serverIdentifier : basename(dir)
    const name = typeof meta.serverName === "string" ? meta.serverName : id
    const entry = loaded.get(id) ?? { name, seen: [] }
    entry.seen.push({ slug: basename(workspace), mtime })
    loaded.set(id, entry)
  }
  return loaded
}

// When the config that would define a loaded server last changed: the user
// or project mcp.json, or the plugin's cached version. Infinity when the
// project file or the whole plugin is gone, null when it cannot be told.
async function definitionChanged(
  id: string,
  origin: LoadedOnly["origin"],
  context: { paths: Locations; projects: string[]; plugins: CursorPlugin[] }
): Promise<number | null> {
  if (origin === "extension") return null
  if (origin === "user") return modifiedAt(context.paths.cursorMcp)
  if (origin === "project") {
    const project = context.projects.find((dir) => id.startsWith(`project-0-${basename(dir)}-`))
    return project ? ((await modifiedAt(join(project, ".cursor", "mcp.json"))) ?? Infinity) : null
  }
  const plugin = context.plugins.find((entry) => id.startsWith(`plugin-${entry.name}-`))
  return plugin ? modifiedAt(plugin.dir) : Infinity
}

async function modifiedAt(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return null
  }
}

const TEMPORARY = [
  /^\/(private\/)?var\/folders\//,
  /^\/(private\/)?tmp\//,
  /[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i
]

// Folders under the home directory count as real even inside the system temp
// folder, which is where --home points in tests.
function isTemporary(dir: string, home: string): boolean {
  if (dir.startsWith(`${resolve(home)}${sep}`)) return false
  return TEMPORARY.some((pattern) => pattern.test(dir)) || dir.startsWith(`${tmpdir()}${sep}`)
}

function isTemporarySlug(slug: string): boolean {
  return /^(private-)?(var-folders|tmp)-|AppData-Local-Temp-/i.test(slug)
}

function cursorServerId(finding: Finding): string {
  if (finding.scope === "plugin") return `plugin-${finding.plugin}-${finding.name}`
  if (finding.scope === "project")
    return `project-0-${basename(finding.project ?? "")}-${finding.name}`
  return `user-${finding.name}`
}

// ~/.cursor/projects/<slug>: the workspace path with every non-alphanumeric
// character turned into a dash.
export function cursorSlug(path: string): string {
  return path.replace(/^[\\/]+/, "").replace(/[^A-Za-z0-9]/g, "-")
}

async function childDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

async function newestChild(dir: string): Promise<string | null> {
  let best: { dir: string; mtime: number } | null = null
  for (const child of await childDirs(dir)) {
    const mtime = (await stat(child)).mtimeMs
    if (!best || mtime > best.mtime) best = { dir: child, mtime }
  }
  return best?.dir ?? null
}

async function existingDirs(candidates: string[]): Promise<string[]> {
  const out = new Set<string>()
  for (const candidate of candidates) {
    const dir = resolve(candidate)
    if (out.has(dir)) continue
    const info = await stat(dir).catch(() => null)
    if (info?.isDirectory()) out.add(dir)
  }
  return [...out].toSorted()
}

async function readJsonOrEmpty(file: string): Promise<Record<string, unknown>> {
  try {
    return await readJson(file)
  } catch {
    return {}
  }
}
