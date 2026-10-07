import { basename } from "node:path";
import { Backup } from "./backup.ts";
import { isManagedServer } from "./codex-toml.ts";
import { fileExists } from "./files.ts";
import { agentsFor, readManifest, writeManifest } from "./manifest.ts";
import { type Context, discoverProjects, globalTargets, locations, projectTargets, type Targets } from "./paths.ts";
import { forAgent, sameServer, secretFields } from "./servers.ts";
import { readAgentServers, writeAgentServers } from "./store.ts";
import { AGENTS, type Agent, isAgent, type Manifest, type ManifestServer, type Server, type ServerMap } from "./types.ts";

export interface CommandOptions {
  ctx: Context;
  manifest: string;
  projects?: string | null;
  agents?: string[];
  prefer?: string;
  includeManaged?: boolean;
  prune?: boolean;
  dryRun?: boolean;
}

export interface Conflict {
  label: string;
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

export async function importConfigs(options: CommandOptions) {
  const warnings: string[] = [];
  const conflicts: Conflict[] = [];
  if (options.prefer && !isAgent(options.prefer)) throw new Error(`Unknown agent for --prefer: ${options.prefer}`);
  const global = await collectBucket(globalTargets(options.ctx), options, warnings, conflicts, "global");
  const projects: Record<string, ServerMap> = {};

  for (const project of await discoverProjects(options.projects)) {
    const present = await existingTargets(projectTargets(project));
    if (!Object.keys(present).length) continue;
    const bucket = await collectBucket(present, options, warnings, conflicts, basename(project));
    const servers: ServerMap = {};
    for (const [name, server] of Object.entries(bucket)) {
      const shared = global[name];
      if (shared && sameServer(shared, server)) {
        warnings.push(`${basename(project)}: ${name} matches the global server, kept global`);
        continue;
      }
      servers[name] = server;
    }
    projects[project] = servers;
  }

  const manifest: Manifest = { version: 1, servers: global, projects };
  if (!options.dryRun) await writeManifest(options.manifest, manifest);
  return { manifest, warnings, conflicts };
}

export async function diffConfigs(options: CommandOptions) {
  const manifest = await readManifest(options.manifest);
  const rows: DiffRow[] = [];
  for (const bucket of buckets(manifest, options.ctx)) rows.push(...(await diffBucket(bucket, options)));
  return { rows };
}

export async function syncConfigs(options: CommandOptions) {
  const manifest = await readManifest(options.manifest);
  const rows: DiffRow[] = [];
  for (const bucket of buckets(manifest, options.ctx)) rows.push(...(await diffBucket(bucket, options)));
  if (options.dryRun) return { rows, wrote: [], removed: [], backup: null };

  const backup = new Backup(locations(options.ctx).stateDir);
  const wrote: string[] = [];
  const removed: string[] = [];
  for (const { label, servers, targets } of buckets(manifest, options.ctx)) {
    for (const agent of selectedAgents(options)) {
      const file = targets[agent];
      const entries = Object.entries(servers)
        .filter(([, server]) => agentsFor(server).includes(agent))
        .map(([name, server]) => ({ name, server: stripManifestFields(server) }));
      if (!entries.length && !(options.prune && (await fileExists(file)))) continue;
      const result = await writeAgentServers(agent, file, entries, { prune: options.prune, backup });
      if (result.changed) wrote.push(`${label} ${agent}`);
      removed.push(...result.removed.map((name) => `${label} ${agent} ${name}`));
    }
  }
  return { rows, wrote, removed, backup: backup.saved.length ? backup : null };
}

interface Bucket {
  label: string;
  servers: ServerMap;
  targets: Record<Agent, string>;
}

function buckets(manifest: Manifest, ctx: Context): Bucket[] {
  return [
    { label: "global", servers: globalServers(manifest), targets: globalTargets(ctx) },
    ...Object.entries(manifest.projects).map(([project, servers]) => ({
      label: basename(project),
      servers,
      targets: projectTargets(project),
    })),
  ];
}

async function collectBucket(
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
      conflicts.push({ label, name, entries });
      continue;
    }
    const chosen = entries.find((entry) => entry.agent === options.prefer)?.server ?? base;
    const merged = Object.assign({}, ...entries.map((entry) => entry.server).reverse(), chosen) as Server;
    servers[name] = { ...merged, agents: [...new Set(entries.map((entry) => entry.agent))] };
  }
  return servers;
}

async function diffBucket({ label, servers, targets }: Bucket, options: CommandOptions): Promise<DiffRow[]> {
  const rows: DiffRow[] = [];
  for (const agent of selectedAgents(options)) {
    const actual = await readAgentServers(agent, targets[agent]);
    const expectedNames = new Set<string>();
    for (const [name, server] of Object.entries(servers)) {
      if (!agentsFor(server).includes(agent)) continue;
      expectedNames.add(name);
      const current = actual[name];
      const expected = forAgent(server, agent);
      if (!current) rows.push({ label, agent, name, status: "missing" });
      else if (!sameServer(forAgent(current, agent), expected)) {
        rows.push({ label, agent, name, status: "different", actual: current, expected });
      } else rows.push({ label, agent, name, status: "same" });
    }
    for (const [name, server] of Object.entries(actual)) {
      if (expectedNames.has(name)) continue;
      rows.push({ label, agent, name, status: "extra", managed: isManagedServer(server) });
    }
  }
  return rows;
}

function stripManifestFields(server: ManifestServer): Server {
  const { agents: _agents, scope: _scope, ...rest } = server;
  return rest;
}

function globalServers(manifest: Manifest): ServerMap {
  return Object.fromEntries(Object.entries(manifest.servers).filter(([, server]) => server.scope !== "project"));
}

async function existingTargets(targets: Record<Agent, string>): Promise<Targets> {
  const present: Targets = {};
  for (const agent of AGENTS) {
    if (await fileExists(targets[agent])) present[agent] = targets[agent];
  }
  return present;
}

function selectedAgents(options: CommandOptions): Agent[] {
  if (!options.agents?.length) return [...AGENTS];
  const unknown = options.agents.filter((agent) => !isAgent(agent));
  if (unknown.length) throw new Error(`Unknown agents: ${unknown.join(", ")}`);
  return options.agents as Agent[];
}
