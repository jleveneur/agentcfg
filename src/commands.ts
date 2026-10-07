import { basename, dirname, join, resolve } from "node:path";
import { Backup } from "./backup.ts";
import { isManagedServer } from "./codex-toml.ts";
import { fileExists } from "./files.ts";
import { agentsFor, readManifest, readManifestOrEmpty, validateServer, writeManifest } from "./manifest.ts";
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
      `No ${MANIFEST_NAME} in ${options.dir} or its parents. Create one with "agentcfg add NAME URL" or "agentcfg import", or pass --global.`,
    );
  }
  const root = dirname(file);
  return { label: basename(root), manifest: file, targets: projectTargets(root) };
}

// Reads the agent files of one scope into its manifest. A project import
// creates <dir>/agentcfg.json.
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

export interface ServerSpec {
  name: string;
  // A URL for a remote server, or a command and its arguments after `--`.
  url?: string;
  command?: string[];
  transport?: string;
  headers?: string[];
  env?: string[];
}

// Adds one server to the project manifest, creating it in the current
// directory when there is none, or to the global manifest with --global.
export async function addServer(options: CommandOptions, spec: ServerSpec) {
  if (!/^[A-Za-z0-9_.-]+$/.test(spec.name)) throw new Error(`Server names use letters, digits, ".", "_" and "-": ${spec.name}`);
  const server = buildServer(spec, options);
  const secrets = secretFields(server);
  if (secrets.length) {
    throw new Error(`Literal secret in ${secrets.join(", ")}. Write it as \${NAME} and set NAME in your environment.`);
  }
  validateServer(server, spec.name);

  const file = await editableManifest(options);
  const manifest = await readManifestOrEmpty(file);
  const current = manifest.servers[spec.name];
  if (current && !options.force) {
    if (sameServer(current, server) && (current.agents ?? []).join() === (server.agents ?? []).join()) {
      return { file, status: "unchanged" as const };
    }
    throw new Error(`${spec.name} is already in ${file}. Pass --force to replace it.`);
  }
  manifest.servers[spec.name] = server;
  if (!options.dryRun) await writeManifest(file, manifest);
  return { file, status: current ? ("replaced" as const) : ("added" as const) };
}

export async function removeServer(options: CommandOptions, name: string) {
  const file = await editableManifest(options, { create: false });
  const manifest = await readManifest(file);
  if (!manifest.servers[name]) throw new Error(`${name} is not in ${file}`);
  delete manifest.servers[name];
  if (!options.dryRun) await writeManifest(file, manifest);
  return { file };
}

async function editableManifest(options: CommandOptions, { create = true } = {}): Promise<string> {
  if (options.global || options.manifest) return (await resolveScope(options)).manifest;
  const found = await findProjectManifest(options.dir, options.ctx);
  if (found) return found;
  if (!create) return (await resolveScope(options)).manifest;
  return join(resolve(options.dir), MANIFEST_NAME);
}

function buildServer(spec: ServerSpec, options: CommandOptions): ManifestServer {
  const agents = options.agents?.length ? options.agents : undefined;
  const unknown = (agents ?? []).filter((agent) => !isAgent(agent));
  if (unknown.length) throw new Error(`Unknown agents: ${unknown.join(", ")}`);
  const env = pairs(spec.env, "=", "--env");
  const headers = pairs(spec.headers, ":", "--header");

  let server: ManifestServer;
  if (spec.command?.length) {
    if (spec.url) throw new Error("Give either a URL or a command after --, not both.");
    if (headers) throw new Error("--header only applies to remote servers.");
    const [command, ...args] = spec.command;
    server = { transport: "stdio", command: command!, ...(args.length ? { args } : {}), ...(env ? { env } : {}) };
  } else if (spec.url) {
    if (env) throw new Error("--env only applies to commands. Remote servers take --header.");
    const transport = spec.transport ?? "http";
    if (transport !== "http" && transport !== "sse") throw new Error(`--transport is http or sse, not ${transport}`);
    server = { transport, url: spec.url, ...(headers ? { headers } : {}) };
  } else {
    throw new Error("Give a URL (agentcfg add NAME URL) or a command (agentcfg add NAME -- COMMAND ARGS...).");
  }
  return agents ? { ...server, agents: agents as Agent[] } : server;
}

function pairs(values: string[] | undefined, separator: string, flag: string): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const out: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf(separator);
    if (at <= 0) throw new Error(`${flag} expects KEY${separator === ":" ? ": " : "="}VALUE, got ${value}`);
    out[value.slice(0, at).trim()] = value.slice(at + 1).trim();
  }
  return out;
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
