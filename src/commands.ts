import { basename, dirname, join, resolve } from "node:path";
import { Backup } from "./backup.ts";
import { isManagedServer } from "./codex-toml.ts";
import { fileExists } from "./files.ts";
import { agentsFor, readManifest, readManifestOrEmpty, writeManifest } from "./manifest.ts";
import {
  type Context,
  findProjectManifest,
  globalTargets,
  locations,
  MANIFEST_NAME,
  projectTargets,
  type Targets,
} from "./paths.ts";
import { forAgent, sameServer, secretFields } from "./servers.ts";
import { readAgentServers, writeAgentServers } from "./store.ts";
import { AGENTS, type Agent, isAgent, type ManifestServer, type Server, type ServerMap } from "./types.ts";

export interface CommandOptions {
  ctx: Context;
  // Directory to start from when looking for or creating a project manifest.
  dir: string;
  global?: boolean;
  manifest?: string;
  agents?: string[];
  prefer?: string;
  includeManaged?: boolean;
  prune?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

export interface Scope {
  label: string;
  manifest: string;
  targets: Record<Agent, string>;
}

export interface Conflict {
  name: string;
  entries: { agent: Agent; server: Server }[];
}

export interface DiffRow {
  label: string;
  agent: Agent;
  name: string;
  status: "same" | "missing" | "different" | "extra";
  managed?: boolean;
  actual?: Server;
  expected?: Server;
}

export async function resolveScope(options: CommandOptions): Promise<Scope> {
  if (options.global) {
    return {
      label: "global",
      manifest: resolve(options.manifest ?? locations(options.ctx).globalManifest),
      targets: globalTargets(options.ctx),
    };
  }
  const file = options.manifest ? resolve(options.manifest) : await findProjectManifest(options.dir, options.ctx);
  if (!file) {
    throw new Error(
      `No ${MANIFEST_NAME} in ${options.dir} or its parents. Create one with "agentcfg add <preset>" or "agentcfg import", or pass --global.`,
    );
  }
  const root = dirname(file);
  return { label: basename(root), manifest: file, targets: projectTargets(root) };
}

// Reads the agent files of one scope into its manifest. A project import
// creates <dir>/agentcfg.json; the global one keeps existing presets.
export async function importConfigs(options: CommandOptions) {
  if (options.prefer && !isAgent(options.prefer)) throw new Error(`Unknown agent for --prefer: ${options.prefer}`);
  const scope: Scope = options.global
    ? await resolveScope(options)
    : (() => {
        const file = resolve(options.manifest ?? join(options.dir, MANIFEST_NAME));
        return { label: basename(dirname(file)), manifest: file, targets: projectTargets(dirname(file)) };
      })();

  const existing = await readManifestOrEmpty(scope.manifest);
  if (Object.keys(existing.servers).length && !options.force) {
    throw new Error(`${scope.manifest} already lists servers. Pass --force to replace them.`);
  }
  const warnings: string[] = [];
  const conflicts: Conflict[] = [];
  const servers = await collect(scope.targets, options, warnings, conflicts, scope.label);
  const manifest = { ...existing, servers };
  if (!options.dryRun) await writeManifest(scope.manifest, manifest);
  return { scope, manifest, warnings, conflicts };
}

// Copies presets from the global manifest into the project manifest,
// creating it in the current directory when there is none.
export async function addPresets(options: CommandOptions, names: string[]) {
  if (!names.length) throw new Error("Name at least one preset: agentcfg add <preset>");
  const globalFile = locations(options.ctx).globalManifest;
  const global = await readManifest(globalFile).catch((error: Error) => {
    throw new Error(`${error.message}. Presets live in the global manifest.`);
  });
  const file = options.manifest
    ? resolve(options.manifest)
    : ((await findProjectManifest(options.dir, options.ctx)) ?? join(resolve(options.dir), MANIFEST_NAME));
  const project = await readManifestOrEmpty(file);
  const added: string[] = [];
  const skipped: string[] = [];

  for (const preset of names) {
    const servers = global.presets?.[preset];
    if (!servers) {
      const known = Object.keys(global.presets ?? {});
      throw new Error(`No preset "${preset}" in ${globalFile}.${known.length ? ` Presets: ${known.join(", ")}.` : ""}`);
    }
    for (const [name, server] of Object.entries(servers)) {
      const current = project.servers[name];
      if (current && sameServer(current, server)) continue;
      if (current && !options.force) {
        skipped.push(name);
        continue;
      }
      project.servers[name] = server;
      added.push(name);
    }
  }
  if (!options.dryRun) await writeManifest(file, project);
  return { file, added, skipped };
}

export async function diffConfigs(options: CommandOptions) {
  const scope = await resolveScope(options);
  const manifest = await readManifest(scope.manifest);
  return { scope, rows: await diffScope(scope, manifest.servers, options) };
}

export async function syncConfigs(options: CommandOptions) {
  const scope = await resolveScope(options);
  const manifest = await readManifest(scope.manifest);
  const rows = await diffScope(scope, manifest.servers, options);
  if (options.dryRun) return { scope, rows, wrote: [], removed: [], backup: null };

  const backup = new Backup(locations(options.ctx).stateDir);
  const wrote: string[] = [];
  const removed: string[] = [];
  for (const agent of selectedAgents(options)) {
    const file = scope.targets[agent];
    const entries = Object.entries(manifest.servers)
      .filter(([, server]) => agentsFor(server).includes(agent))
      .map(([name, server]) => ({ name, server: withoutAgents(server) }));
    if (!entries.length && !(options.prune && (await fileExists(file)))) continue;
    const result = await writeAgentServers(agent, file, entries, { prune: options.prune, backup });
    if (result.changed) wrote.push(file);
    removed.push(...result.removed.map((name) => `${agent} ${name}`));
  }
  return { scope, rows, wrote, removed, backup: backup.saved.length ? backup : null };
}

async function collect(
  targets: Targets,
  options: CommandOptions,
  warnings: string[],
  conflicts: Conflict[],
  label: string,
): Promise<ServerMap> {
  const found = new Map<string, { agent: Agent; server: Server }[]>();
  for (const agent of AGENTS) {
    const file = targets[agent];
    if (!file) continue;
    for (const [name, server] of Object.entries(await readAgentServers(agent, file))) {
      if (!options.includeManaged && isManagedServer(server)) {
        warnings.push(`${label} ${agent}: skipped ${name} (managed by the agent app)`);
        continue;
      }
      const secrets = secretFields(server);
      if (secrets.length) {
        warnings.push(`${label} ${agent}: skipped ${name} (literal secret in ${secrets.join(", ")})`);
        continue;
      }
      const list = found.get(name) ?? [];
      list.push({ agent, server });
      found.set(name, list);
    }
  }

  const servers: ServerMap = {};
  for (const [name, entries] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const base = entries[0]!.server;
    // Compare what every format can hold. Codex-only fields such as
    // startup_timeout_sec are merged in rather than reported as conflicts.
    const conflict = entries.some((entry) => !sameServer(forAgent(entry.server, "cursor"), forAgent(base, "cursor")));
    if (conflict && !options.prefer) {
      conflicts.push({ name, entries });
      continue;
    }
    const chosen = entries.find((entry) => entry.agent === options.prefer)?.server ?? base;
    const merged = Object.assign({}, ...entries.map((entry) => entry.server).reverse(), chosen) as Server;
    const agents = [...new Set(entries.map((entry) => entry.agent))];
    servers[name] = agents.length === AGENTS.length ? merged : { ...merged, agents };
  }
  return servers;
}

async function diffScope(scope: Scope, servers: ServerMap, options: CommandOptions): Promise<DiffRow[]> {
  const rows: DiffRow[] = [];
  for (const agent of selectedAgents(options)) {
    const actual = await readAgentServers(agent, scope.targets[agent]);
    const expectedNames = new Set<string>();
    for (const [name, server] of Object.entries(servers)) {
      if (!agentsFor(server).includes(agent)) continue;
      expectedNames.add(name);
      const current = actual[name];
      const expected = forAgent(server, agent);
      const label = scope.label;
      if (!current) rows.push({ label, agent, name, status: "missing" });
      else if (!sameServer(forAgent(current, agent), expected)) {
        rows.push({ label, agent, name, status: "different", actual: current, expected });
      } else rows.push({ label, agent, name, status: "same" });
    }
    for (const [name, server] of Object.entries(actual)) {
      if (expectedNames.has(name)) continue;
      rows.push({ label: scope.label, agent, name, status: "extra", managed: isManagedServer(server) });
    }
  }
  return rows;
}

function withoutAgents(server: ManifestServer): Server {
  const { agents: _agents, ...rest } = server;
  return rest;
}

function selectedAgents(options: CommandOptions): Agent[] {
  if (!options.agents?.length) return [...AGENTS];
  const unknown = options.agents.filter((agent) => !isAgent(agent));
  if (unknown.length) throw new Error(`Unknown agents: ${unknown.join(", ")}`);
  return options.agents as Agent[];
}
