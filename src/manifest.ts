import { readFile } from "node:fs/promises";
import { formatJson, isMissing, isRecord, writeFileAtomic } from "./files.ts";
import { AGENTS, isAgent, type Agent, type Manifest, type ManifestServer, type ServerMap } from "./types.ts";

export function emptyManifest(): Manifest {
  return { version: 1, servers: {} };
}

export async function readManifest(file: string): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) throw new Error(`${file} does not exist`);
    throw error;
  }
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || !isRecord(data.servers)) throw new Error(`${file} must contain a servers object`);
  if ("projects" in data) {
    throw new Error(`${file} lists projects. Each project now keeps its own agentcfg.json at its root.`);
  }
  const manifest: Manifest = { version: 1, servers: data.servers as ServerMap };
  if (isRecord(data.presets)) manifest.presets = data.presets as Record<string, ServerMap>;
  validate(manifest, file);
  return manifest;
}

export async function readManifestOrEmpty(file: string): Promise<Manifest> {
  try {
    return await readManifest(file);
  } catch (error) {
    if ((error as Error).message === `${file} does not exist`) return emptyManifest();
    throw error;
  }
}

export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  const ordered: Manifest = { version: 1, servers: sortServers(manifest.servers) };
  if (manifest.presets && Object.keys(manifest.presets).length) {
    ordered.presets = Object.fromEntries(
      Object.entries(manifest.presets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, servers]) => [name, sortServers(servers)]),
    );
  }
  await writeFileAtomic(file, formatJson(ordered));
}

function sortServers(servers: ServerMap): ServerMap {
  return Object.fromEntries(Object.entries(servers).sort(([a], [b]) => a.localeCompare(b)));
}

export function agentsFor(server: ManifestServer): Agent[] {
  return server.agents ?? [...AGENTS];
}

function validate(manifest: Manifest, file: string): void {
  const groups: [string, ServerMap][] = [
    ["", manifest.servers],
    ...Object.entries(manifest.presets ?? {}).map(([name, servers]): [string, ServerMap] => [`preset ${name}: `, servers]),
  ];
  for (const [prefix, servers] of groups) {
    if (!isRecord(servers)) throw new Error(`${file}: ${prefix}servers must be an object`);
    for (const [name, server] of Object.entries(servers)) {
      const where = `${file}: ${prefix}${name}`;
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
