import { AGENTS, resolveTargets } from "./paths.js";
import { agentsFor, readManifest, sameServer, writeManifest } from "./manifest.js";
import { isManagedServer, readAgentServers, secretFields, writeAgentServers } from "./store.js";

export async function importConfigs(options) {
  const targets = resolveTargets(options);
  const found = new Map();
  const warnings = [];

  for (const agent of AGENTS) {
    const servers = await readAgentServers(agent, targets[agent]);
    for (const [name, server] of Object.entries(servers)) {
      if (!options.includeManaged && isManagedServer(server)) {
        warnings.push(`${agent}: skipped ${name} (managed by the agent app)`);
        continue;
      }
      const secrets = secretFields(server);
      if (secrets.length) {
        warnings.push(`${agent}: skipped ${name} (literal secret in ${secrets.join(", ")})`);
        continue;
      }
      if (!found.has(name)) found.set(name, []);
      found.get(name).push({ agent, server });
    }
  }

  const manifest = { version: 1, servers: {} };
  const conflicts = [];
  for (const [name, entries] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const base = entries[0].server;
    const conflict = entries.find((entry) => !sameServer(entry.server, base));
    if (conflict && !options.prefer) {
      conflicts.push({
        name,
        entries: entries.map((entry) => ({ agent: entry.agent, server: entry.server })),
      });
      continue;
    }
    const chosen = options.prefer
      ? entries.find((entry) => entry.agent === options.prefer)?.server ?? base
      : base;
    manifest.servers[name] = {
      ...chosen,
      agents: [...new Set(entries.map((entry) => entry.agent))],
    };
  }

  if (!options.dryRun) await writeManifest(options.manifest, manifest);
  return { manifest, warnings, conflicts, targets };
}

export async function diffConfigs(options) {
  const targets = resolveTargets(options);
  const manifest = await readManifest(options.manifest);
  const rows = [];

  for (const agent of selectedAgents(options)) {
    const actual = await readAgentServers(agent, targets[agent]);
    const expectedNames = new Set();
    for (const [name, server] of Object.entries(manifest.servers)) {
      if (!agentsFor(server).includes(agent)) continue;
      expectedNames.add(name);
      if (!actual[name]) {
        rows.push({ agent, name, status: "missing" });
      } else if (!sameServer(actual[name], server)) {
        rows.push({ agent, name, status: "different", actual: actual[name], expected: server });
      } else {
        rows.push({ agent, name, status: "same" });
      }
    }
    for (const name of Object.keys(actual)) {
      if (expectedNames.has(name)) continue;
      rows.push({
        agent,
        name,
        status: "extra",
        managed: isManagedServer(actual[name]),
      });
    }
  }

  return { rows, targets };
}

export async function syncConfigs(options) {
  const report = await diffConfigs(options);
  if (options.dryRun) return { ...report, wrote: [] };

  const manifest = await readManifest(options.manifest);
  const wrote = [];
  for (const agent of selectedAgents(options)) {
    const entries = Object.entries(manifest.servers)
      .filter(([, server]) => agentsFor(server).includes(agent))
      .map(([name, server]) => ({ name, server }));
    await writeAgentServers(agent, report.targets[agent], entries, { prune: options.prune });
    wrote.push(agent);
  }
  return { ...report, wrote };
}

function selectedAgents(options) {
  if (!options.agents?.length) return AGENTS;
  const unknown = options.agents.filter((agent) => !AGENTS.includes(agent));
  if (unknown.length) throw new Error(`Unknown agents: ${unknown.join(", ")}`);
  return options.agents;
}
