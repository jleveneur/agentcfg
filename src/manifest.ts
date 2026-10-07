import { readFile } from "node:fs/promises";
import { isRecord, writeFileAtomic } from "./files.ts";
import { AGENTS, isAgent, type Agent, type Manifest, type ManifestServer, type ServerMap } from "./types.ts";

export function emptyManifest(): Manifest {
  return { version: 1, servers: {}, projects: {} };
}

export async function readManifest(file: string): Promise<Manifest> {
  const data: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(data) || !isRecord(data.servers)) {
    throw new Error(`${file} must contain a servers object`);
  }
  const manifest: Manifest = {
    version: 1,
    servers: data.servers as ServerMap,
    projects: isRecord(data.projects) ? (data.projects as Record<string, ServerMap>) : {},
  };
  validate(manifest, file);
  return manifest;
}

export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  const ordered = {
    version: 1,
    servers: sortServers(manifest.servers, "global"),
    projects: Object.fromEntries(
      Object.entries(manifest.projects ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([project, servers]) => [project, sortServers(servers, "project")]),
    ),
  };
  await writeFileAtomic(file, `${JSON.stringify(ordered, null, 2)}\n`);
}

function sortServers(servers: ServerMap, scope: "global" | "project"): ServerMap {
  return Object.fromEntries(
    Object.entries(servers ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, server]) => {
        const { scope: _scope, ...rest } = server;
        return [name, { ...rest, scope }];
      }),
  );
}

export function agentsFor(server: ManifestServer): Agent[] {
  return server.agents ?? [...AGENTS];
}

function validate(manifest: Manifest, file: string): void {
  const buckets: [string, ServerMap][] = [["servers", manifest.servers], ...Object.entries(manifest.projects)];
  for (const [bucket, servers] of buckets) {
    for (const [name, server] of Object.entries(servers)) {
      const where = `${file}: ${bucket === "servers" ? "" : `${bucket} `}${name}`;
      if (!isRecord(server)) throw new Error(`${where} must be an object`);
      if (!["stdio", "http", "sse"].includes(server.transport)) {
        throw new Error(`${where} needs transport "stdio", "http", or "sse"`);
      }
      if (server.transport === "stdio" && typeof server.command !== "string") throw new Error(`${where} needs a command`);
      if (server.transport !== "stdio" && typeof server.url !== "string") throw new Error(`${where} needs a url`);
      const unknown = (server.agents ?? []).filter((agent) => !isAgent(agent));
      if (unknown.length) throw new Error(`${where} lists unknown agents: ${unknown.join(", ")}`);
    }
  }
}
