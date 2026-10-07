import { access } from "node:fs/promises";
import { basename } from "node:path";
import { AGENTS, discoverProjects, projectTargets, resolveTargets } from "./paths.js";
import { agentsFor, readManifest, sameServer, writeManifest } from "./manifest.js";
import { isManagedServer, readAgentServers, secretFields, writeAgentServers } from "./store.js";

export async function importConfigs(options) {
  const targets = resolveTargets(options);
  const warnings = [];
  const conflicts = [];
  const global = await collectBucket(targets, options, warnings, conflicts, "global");
  const projects = {};

  for (const project of await projectDirectories(options)) {
    const projectFiles = projectTargets(project);
    const present = await existingTargets(projectFiles);
    if (!Object.keys(present).length) continue;
    const bucket = await collectBucket(present, options, warnings, conflicts, basename(project));
    const servers = {};
    for (const [name, server] of Object.entries(bucket)) {
      if (global[name] && sameServer(global[name], server)) {
        warnings.push(`${basename(project)}: ${name} matches the global server, kept global`);
        continue;
      }
      servers[name] = server;
    }
    projects[project] = servers;
  }

  const manifest = { version: 1, servers: global, projects };
  if (!options.dryRun) await writeManifest(options.manifest, manifest);
  return { manifest, warnings, conflicts, targets };
}

export async function diffConfigs(options) {
  const manifest = await readManifest(options.manifest);
  const rows = [];
  const globalTargets = resolveTargets(options);
  rows.push(
    ...(await diffBucket({
      label: "global",
      servers: globalServers(manifest),
      targets: globalTargets,
      options,
    })),
  );

  for (const [project, servers] of Object.entries(manifest.projects ?? {})) {
    rows.push(
      ...(await diffBucket({
        label: basename(project),
        servers,
        targets: projectTargets(project),
        options,
      })),
    );
  }

  return { rows, targets: globalTargets };
}

export async function syncConfigs(options) {
  const report = await diffConfigs(options);
  if (options.dryRun) return { ...report, wrote: [] };

  const manifest = await readManifest(options.manifest);
  const wrote = [];
  wrote.push(
    ...(await syncBucket({
      label: "global",
      servers: globalServers(manifest),
      targets: resolveTargets(options),
      options,
    })),
  );
  for (const [project, servers] of Object.entries(manifest.projects ?? {})) {
    wrote.push(
      ...(await syncBucket({
        label: basename(project),
        servers,
        targets: projectTargets(project),
        options,
      })),
    );
  }
  return { ...report, wrote };
}

async function collectBucket(targets, options, warnings, conflicts, label) {
  const found = new Map();
  for (const agent of AGENTS) {
    if (!targets[agent]) continue;
    const servers = await readAgentServers(agent, targets[agent]);
    for (const [name, raw] of Object.entries(servers)) {
      const server = raw;
      if (!options.includeManaged && isManagedServer(server)) {
        warnings.push(`${label} ${agent}: skipped ${name} (managed by the agent app)`);
        continue;
      }
      const secrets = secretFields(server);
      if (secrets.length) {
        warnings.push(`${label} ${agent}: skipped ${name} (literal secret in ${secrets.join(", ")})`);
        continue;
      }
      if (!found.has(name)) found.set(name, []);
      found.get(name).push({ agent, server });
    }
  }

  const servers = {};
  for (const [name, entries] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const base = entries[0].server;
    const conflict = entries.find((entry) => !sameServer(entry.server, base));
    if (conflict && !options.prefer) {
      conflicts.push({
        label,
        name,
        entries: entries.map((entry) => ({ agent: entry.agent, server: entry.server })),
      });
      continue;
    }
    const chosen = options.prefer
      ? entries.find((entry) => entry.agent === options.prefer)?.server ?? base
      : base;
    servers[name] = {
      ...chosen,
      agents: [...new Set(entries.map((entry) => entry.agent))],
    };
  }
  return servers;
}

async function diffBucket({ label, servers, targets, options }) {
  const rows = [];
  for (const agent of selectedAgents(options)) {
    if (!targets[agent]) continue;
    const actual = await readAgentServers(agent, targets[agent]);
    const expectedNames = new Set();
    for (const [name, server] of Object.entries(servers ?? {})) {
      if (!agentsFor(server).includes(agent)) continue;
      expectedNames.add(name);
      if (!actual[name]) {
        rows.push({ label, agent, name, status: "missing" });
      } else if (!sameServer(actual[name], server)) {
        rows.push({ label, agent, name, status: "different", actual: actual[name], expected: server });
      } else {
        rows.push({ label, agent, name, status: "same" });
      }
    }
    for (const name of Object.keys(actual)) {
      if (expectedNames.has(name)) continue;
      rows.push({
        label,
        agent,
        name,
        status: "extra",
        managed: isManagedServer(actual[name]),
      });
    }
  }
  return rows;
}

async function syncBucket({ label, servers, targets, options }) {
  const wrote = [];
  for (const agent of selectedAgents(options)) {
    const entries = Object.entries(servers ?? {})
      .filter(([, server]) => agentsFor(server).includes(agent))
      .map(([name, server]) => ({ name, server }));
    const file = targets[agent];
    const exists = await fileExists(file);
    if (!entries.length && !(options.prune && exists)) continue;
    await writeAgentServers(agent, file, entries, { prune: options.prune });
    wrote.push(`${label} ${agent}`);
  }
  return wrote;
}

function globalServers(manifest) {
  return Object.fromEntries(
    Object.entries(manifest.servers ?? {}).filter(([, server]) => server.scope !== "project"),
  );
}

async function projectDirectories(options) {
  if (!options.projects) return [];
  return discoverProjects(options.projects);
}

async function existingTargets(targets) {
  const present = {};
  for (const [agent, file] of Object.entries(targets)) {
    if (await fileExists(file)) present[agent] = file;
  }
  return present;
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function selectedAgents(options) {
  if (!options.agents?.length) return AGENTS;
  const unknown = options.agents.filter((agent) => !AGENTS.includes(agent));
  if (unknown.length) throw new Error(`Unknown agents: ${unknown.join(", ")}`);
  return options.agents;
}
