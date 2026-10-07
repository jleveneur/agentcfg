import { readFile, writeFile } from "node:fs/promises";
import { AGENTS } from "./paths.js";

export function emptyManifest() {
  return { version: 1, servers: {}, projects: {} };
}

export async function readManifest(file) {
  const text = await readFile(file, "utf8");
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || !data.servers || typeof data.servers !== "object") {
    throw new Error(`${file} must contain a servers object`);
  }
  return {
    version: data.version ?? 1,
    servers: data.servers,
    projects: data.projects && typeof data.projects === "object" ? data.projects : {},
  };
}

export async function writeManifest(file, manifest) {
  const ordered = {
    version: 1,
    servers: sortServers(manifest.servers, "global"),
    projects: Object.fromEntries(
      Object.entries(manifest.projects ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([project, servers]) => [project, sortServers(servers, "project")]),
    ),
  };
  await writeFile(file, `${JSON.stringify(ordered, null, 2)}\n`);
}

function sortServers(servers, scope) {
  return Object.fromEntries(
    Object.entries(servers ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, server]) => [name, { ...serverWithoutScope(server), scope }]),
  );
}

function serverWithoutScope(server) {
  const { scope: _scope, ...rest } = server;
  return rest;
}

export function agentsFor(server) {
  if (!server.agents) return [...AGENTS];
  const unknown = server.agents.filter((agent) => !AGENTS.includes(agent));
  if (unknown.length) {
    throw new Error(`Unknown agents: ${unknown.join(", ")}`);
  }
  return server.agents;
}

export function signature(server) {
  return JSON.stringify({
    transport: server.transport,
    url: server.url ?? null,
    command: server.command ?? null,
    args: server.args ?? [],
    env: server.env ?? {},
    headers: server.headers ?? {},
    bearerTokenEnvVar: server.bearerTokenEnvVar ?? null,
    enabled: server.enabled !== false,
    cwd: server.cwd ?? null,
    startupTimeoutSec: server.startupTimeoutSec ?? null,
  });
}

export function sameServer(left, right) {
  return signature(left) === signature(right);
}
