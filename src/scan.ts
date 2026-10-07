import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isManagedServer, parseToml, readCodexServers } from "./codex-toml.ts";
import { fileExists, isRecord, readJson, readText } from "./files.ts";
import { type Context, discoverProjects, locations } from "./paths.ts";
import { fromJsonServers, identity, redact } from "./servers.ts";
import type { Server, ServerMap } from "./types.ts";

export type Scope = "user" | "local" | "project" | "plugin";

export interface Finding {
  agent: string;
  scope: Scope;
  name: string;
  file: string;
  project?: string;
  plugin?: string;
  enabled: boolean;
  managed?: boolean;
  // Cursor workspaces whose last session loaded this server.
  loadedIn?: string[];
  server: Server;
}

// A server Cursor loaded that no file on disk defines any more: one added by
// an IDE extension, or one removed from its config since.
export interface LoadedOnly {
  id: string;
  name: string;
  origin: "user" | "project" | "plugin" | "extension";
  workspaces: string[];
}

export interface ScanResult {
  findings: Finding[];
  loadedOnly: LoadedOnly[];
  projects: string[];
  warnings: string[];
}

export interface ScanOptions {
  ctx: Context;
  projects?: string | null;
  cwd?: string;
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const paths = locations(options.ctx);
  const findings: Finding[] = [];
  const warnings: string[] = [];

  const add = (base: Omit<Finding, "name" | "server" | "enabled"> & { enabled?: boolean }, servers: ServerMap) => {
    for (const [name, server] of Object.entries(servers)) {
      findings.push({
        ...base,
        name,
        enabled: base.enabled !== false && server.enabled !== false,
        managed: isManagedServer(server) || undefined,
        server: redact(server),
      });
    }
  };
  const safely = async (label: string, task: () => Promise<void>) => {
    try {
      await task();
    } catch (error) {
      warnings.push(`${label}: ${(error as Error).message}`);
    }
  };

  // User-level files.
  await safely("cursor", async () => add({ agent: "cursor", scope: "user", file: paths.cursorMcp }, await jsonServers(paths.cursorMcp)));
  const claudeJson = await readJson(paths.claudeJson).catch((error: Error) => {
    warnings.push(`claude: ${error.message}`);
    return {} as Record<string, unknown>;
  });
  add({ agent: "claude", scope: "user", file: paths.claudeJson }, fromJsonServers(claudeJson.mcpServers));
  const claudeProjects = isRecord(claudeJson.projects) ? claudeJson.projects : {};
  for (const [project, config] of Object.entries(claudeProjects)) {
    if (!isRecord(config)) continue;
    add({ agent: "claude", scope: "local", project, file: paths.claudeJson }, fromJsonServers(config.mcpServers));
  }

  let codexConfig: Record<string, unknown> = {};
  await safely("codex", async () => {
    const text = await readText(paths.codexConfig);
    if (!text) return;
    codexConfig = parseToml(text, paths.codexConfig);
    add({ agent: "codex", scope: "user", file: paths.codexConfig }, readCodexServers(text, paths.codexConfig));
  });

  await safely("claude-desktop", async () =>
    add({ agent: "claude-desktop", scope: "user", file: paths.claudeDesktop }, await jsonServers(paths.claudeDesktop)),
  );
  await safely("vscode", async () =>
    add({ agent: "vscode", scope: "user", file: paths.vscodeUser }, await jsonServers(paths.vscodeUser, "servers")),
  );
  await safely("windsurf", async () =>
    add({ agent: "windsurf", scope: "user", file: paths.windsurf }, await jsonServers(paths.windsurf)),
  );
  await safely("gemini", async () => add({ agent: "gemini", scope: "user", file: paths.gemini }, await jsonServers(paths.gemini)));

  // Project files. Projects come from --projects, the current directory, and
  // the projects Claude Code and Codex already know about.
  const codexProjects = isRecord(codexConfig.projects) ? Object.keys(codexConfig.projects) : [];
  // The home directory is not a project: its .cursor/mcp.json is the user file.
  const projects = (await existingDirs([
    ...(await discoverProjects(options.projects)),
    ...(options.cwd ? [options.cwd] : []),
    ...Object.keys(claudeProjects),
    ...codexProjects,
  ])).filter((dir) => dir !== resolve(options.ctx.home));
  const cursorProjectPlugins = new Map<string, string[]>();
  for (const project of projects) {
    const files: [string, string, string, string?][] = [
      ["cursor", ".cursor/mcp.json", "json"],
      ["claude", ".mcp.json", "json"],
      ["codex", ".codex/config.toml", "toml"],
      ["vscode", ".vscode/mcp.json", "json", "servers"],
      ["gemini", ".gemini/settings.json", "json"],
    ];
    for (const [agent, relative, format, key] of files) {
      const file = join(project, relative);
      await safely(file, async () => {
        const servers = format === "toml" ? readCodexServers((await readText(file)) ?? "", file) : await jsonServers(file, key);
        add({ agent, scope: "project", project, file }, servers);
      });
    }
    const settings = await readJson(join(project, ".cursor", "settings.json")).catch(() => ({}) as Record<string, unknown>);
    if (isRecord(settings.plugins)) {
      for (const [plugin, config] of Object.entries(settings.plugins)) {
        if (isRecord(config) && config.enabled === true) {
          cursorProjectPlugins.set(plugin, [...(cursorProjectPlugins.get(plugin) ?? []), project]);
        }
      }
    }
  }

  // Plugins.
  await safely("claude plugins", async () => {
    const installed = await readJson(paths.claudePlugins);
    const settings = await readJson(paths.claudeSettings);
    const enabledPlugins = isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
    for (const [key, installs] of Object.entries(isRecord(installed.plugins) ? installed.plugins : {})) {
      for (const install of Array.isArray(installs) ? installs : []) {
        if (!isRecord(install) || typeof install.installPath !== "string") continue;
        const project = typeof install.projectPath === "string" ? install.projectPath : undefined;
        for (const { file, servers } of await pluginServers(install.installPath, ".claude-plugin")) {
          add({ agent: "claude", scope: "plugin", plugin: key, project, file, enabled: enabledPlugins[key] === true }, servers);
        }
      }
    }
  });

  await safely("codex plugins", async () => {
    const plugins = isRecord(codexConfig.plugins) ? codexConfig.plugins : {};
    for (const [key, config] of Object.entries(plugins)) {
      const [name, marketplace] = key.split("@");
      if (!name || !marketplace) continue;
      const dir = await newestChild(join(paths.codexPlugins, marketplace, name));
      if (!dir) continue;
      const enabled = !(isRecord(config) && config.enabled === false);
      for (const { file, servers } of await pluginServers(dir, ".codex-plugin")) {
        add({ agent: "codex", scope: "plugin", plugin: key, file, enabled }, servers);
      }
    }
  });

  await safely("cursor plugins", async () => {
    for (const plugin of await cursorPlugins(paths.cursorPlugins)) {
      for (const { file, servers } of await pluginServers(plugin.dir, ".cursor-plugin")) {
        add({ agent: "cursor", scope: "plugin", plugin: plugin.name, file }, servers);
      }
    }
  });

  // What Cursor actually loaded, per workspace.
  const loaded = await cursorLoaded(paths.cursorProjects);
  const slugs = new Map(projects.map((project) => [cursorSlug(project), project]));
  const matched = new Set<string>();
  for (const finding of findings) {
    if (finding.agent !== "cursor") continue;
    const id = cursorServerId(finding);
    const workspaces = loaded.get(id)?.workspaces;
    if (workspaces) matched.add(id);
    finding.loadedIn = (workspaces ?? []).map((slug) => slugs.get(slug) ?? slug);
    if (finding.scope === "plugin") {
      const enabledBy = cursorProjectPlugins.get(finding.plugin ?? "") ?? [];
      finding.enabled = finding.enabled && (finding.loadedIn.length > 0 || enabledBy.length > 0);
    }
  }
  const loadedOnly: LoadedOnly[] = [];
  for (const [id, entry] of loaded) {
    if (matched.has(id) || id.startsWith("cursor-")) continue;
    loadedOnly.push({
      id,
      name: entry.name,
      origin: id.includes("-extension-") ? "extension" : id.startsWith("plugin-") ? "plugin" : id.startsWith("project-") ? "project" : "user",
      workspaces: entry.workspaces.map((slug) => slugs.get(slug) ?? slug),
    });
  }

  return { findings, loadedOnly: loadedOnly.sort((a, b) => a.id.localeCompare(b.id)), projects, warnings };
}

export interface Group {
  identity: string;
  names: string[];
  findings: Finding[];
}

export function groupFindings(findings: Finding[]): Group[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = identity(finding.server);
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ identity: key, names: [...new Set(list.map((finding) => finding.name))], findings: list }))
    .sort((a, b) => b.findings.length - a.findings.length || a.identity.localeCompare(b.identity));
}

async function jsonServers(file: string, key = "mcpServers"): Promise<ServerMap> {
  const data = await readJson(file);
  return fromJsonServers(data[key]);
}

// A plugin declares its servers in <manifestDir>/plugin.json, inline or as a
// path, or ships them in .mcp.json or mcp.json at its root.
async function pluginServers(dir: string, manifestDir: string): Promise<{ file: string; servers: ServerMap }[]> {
  for (const manifest of [join(dir, manifestDir, "plugin.json"), join(dir, "plugin.json")]) {
    const data = await readJson(manifest).catch(() => ({}) as Record<string, unknown>);
    const declared = data.mcpServers;
    if (declared == null) continue;
    const refs = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared.map(String) : null;
    if (!refs) return [{ file: manifest, servers: fromJsonServers(declared) }];
    const out = [];
    for (const ref of refs) {
      const file = resolve(dir, ref);
      out.push({ file, servers: serverMapFrom(await readJson(file)) });
    }
    return out;
  }
  for (const name of [".mcp.json", "mcp.json"]) {
    const file = join(dir, name);
    if (await fileExists(file)) return [{ file, servers: serverMapFrom(await readJson(file)) }];
  }
  return [];
}

function serverMapFrom(data: Record<string, unknown>): ServerMap {
  return fromJsonServers(isRecord(data.mcpServers) ? data.mcpServers : data);
}

// Cursor caches plugins as <marketplace>/<id or name>/<commit>/. Several
// commits of one plugin can sit side by side; the newest one wins.
async function cursorPlugins(cacheDir: string): Promise<{ name: string; dir: string }[]> {
  const newest = new Map<string, { dir: string; mtime: number }>();
  for (const marketplace of await childDirs(cacheDir)) {
    for (const entry of await childDirs(marketplace)) {
      for (const dir of await childDirs(entry)) {
        if (!(await readdir(dir)).length) continue;
        const manifest = { ...(await readJson(join(dir, "plugin.json")).catch(() => ({}))), ...(await readJson(join(dir, ".cursor-plugin", "plugin.json")).catch(() => ({}))) };
        const name = typeof manifest.name === "string" ? manifest.name : basename(entry);
        const mtime = (await stat(dir)).mtimeMs;
        const current = newest.get(name);
        if (!current || mtime > current.mtime) newest.set(name, { dir, mtime });
      }
    }
  }
  return [...newest.entries()].map(([name, { dir }]) => ({ name, dir }));
}

async function cursorLoaded(projectsDir: string): Promise<Map<string, { name: string; workspaces: string[] }>> {
  const loaded = new Map<string, { name: string; workspaces: string[] }>();
  for (const workspace of await childDirs(projectsDir)) {
    for (const dir of await childDirs(join(workspace, "mcps"))) {
      const meta = await readJson(join(dir, "SERVER_METADATA.json")).catch(() => ({}) as Record<string, unknown>);
      const id = typeof meta.serverIdentifier === "string" ? meta.serverIdentifier : basename(dir);
      const name = typeof meta.serverName === "string" ? meta.serverName : id;
      const entry = loaded.get(id) ?? { name, workspaces: [] };
      entry.workspaces.push(basename(workspace));
      loaded.set(id, entry);
    }
  }
  return loaded;
}

function cursorServerId(finding: Finding): string {
  if (finding.scope === "plugin") return `plugin-${finding.plugin}-${finding.name}`;
  if (finding.scope === "project") return `project-0-${basename(finding.project ?? "")}-${finding.name}`;
  return `user-${finding.name}`;
}

// ~/.cursor/projects/<slug>: the workspace path with every non-alphanumeric
// character turned into a dash.
export function cursorSlug(path: string): string {
  return path.replace(/^[\\/]+/, "").replace(/[^A-Za-z0-9]/g, "-");
}

async function childDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

async function newestChild(dir: string): Promise<string | null> {
  let best: { dir: string; mtime: number } | null = null;
  for (const child of await childDirs(dir)) {
    const mtime = (await stat(child)).mtimeMs;
    if (!best || mtime > best.mtime) best = { dir: child, mtime };
  }
  return best?.dir ?? null;
}

async function existingDirs(candidates: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const candidate of candidates) {
    const dir = resolve(candidate);
    if (out.has(dir)) continue;
    const info = await stat(dir).catch(() => null);
    if (info?.isDirectory()) out.add(dir);
  }
  return [...out].sort();
}
