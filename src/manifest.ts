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
  if ("presets" in data) {
    throw new Error(`${file} has presets, which agentcfg no longer reads. List the servers in each project's agentcfg.json.`);
  }
  const manifest: Manifest = { version: 1, servers: data.servers as ServerMap };
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
  await writeFileAtomic(file, formatJson({ version: 1, servers: sortServers(manifest.servers) }));
}

function sortServers(servers: ServerMap): ServerMap {
  return Object.fromEntries(Object.entries(servers).sort(([a], [b]) => a.localeCompare(b)));
}

export function agentsFor(server: ManifestServer): Agent[] {
  return server.agents ?? [...AGENTS];
}

export function validateServer(server: unknown, where: string): asserts server is ManifestServer {
  if (!isRecord(server)) throw new Error(`${where} must be an object`);
  if (!["stdio", "http", "sse"].includes(server.transport as string)) {
    throw new Error(`${where} needs transport "stdio", "http", or "sse"`);
  }
  if (server.transport === "stdio" && typeof server.command !== "string") throw new Error(`${where} needs a command`);
  if (server.transport !== "stdio" && typeof server.url !== "string") throw new Error(`${where} needs a url`);
  const agents = Array.isArray(server.agents) ? (server.agents as string[]) : [];
  const unknown = agents.filter((agent) => !isAgent(agent));
  if (unknown.length) throw new Error(`${where} lists unknown agents: ${unknown.join(", ")}`);
}

function validate(manifest: Manifest, file: string): void {
  for (const [name, server] of Object.entries(manifest.servers)) validateServer(server, `${file}: ${name}`);
}
