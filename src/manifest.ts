import { readFile } from "node:fs/promises"

import { errorMessage, formatJson, isMissing, isRecord, writeFileAtomic } from "./files.ts"
import {
  type Agent,
  DEFAULT_AGENTS,
  isAgent,
  type Manifest,
  type ManifestServer,
  type ServerMap
} from "./types.ts"

// Where editors fetch the schema that agentcfg.json files point to.
export const SCHEMA_URL = "https://unpkg.com/@jleveneur/agentcfg/agentcfg.schema.json"

export function emptyManifest(agents?: Agent[]): Manifest {
  return { $schema: SCHEMA_URL, version: 1, ...(agents ? { agents } : {}), servers: {} }
}

export class MissingManifest extends Error {}

export async function readManifest(file: string): Promise<Manifest> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if (isMissing(error)) throw new MissingManifest(`${file} does not exist`, { cause: error })
    throw error
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${errorMessage(error)}`, { cause: error })
  }
  if (!isRecord(data) || !isRecord(data.servers)) {
    throw new Error(`${file} must contain a servers object`)
  }
  if ("projects" in data) {
    throw new Error(
      `${file} lists projects. Each project now keeps its own agentcfg.json at its root.`
    )
  }
  if ("presets" in data) {
    throw new Error(
      `${file} has presets, which agentcfg no longer reads. List the servers in each project's agentcfg.json.`
    )
  }
  const agents = readAgents(data.agents, file)
  const servers: ServerMap = {}
  for (const [name, server] of Object.entries(data.servers)) {
    validateServer(server, `${file}: ${name}`, agents ?? DEFAULT_AGENTS)
    servers[name] = server
  }
  return {
    ...(typeof data.$schema === "string" ? { $schema: data.$schema } : {}),
    version: 1,
    ...(agents ? { agents } : {}),
    servers
  }
}

export async function readManifestOrEmpty(file: string): Promise<Manifest> {
  try {
    return await readManifest(file)
  } catch (error) {
    if (error instanceof MissingManifest) return emptyManifest()
    throw error
  }
}

export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  const servers = Object.fromEntries(
    Object.entries(manifest.servers).toSorted(([a], [b]) => a.localeCompare(b))
  )
  await writeFileAtomic(
    file,
    formatJson({
      ...(manifest.$schema ? { $schema: manifest.$schema } : {}),
      version: 1,
      ...(manifest.agents ? { agents: manifest.agents } : {}),
      servers
    })
  )
}

export function manifestAgents(manifest: Manifest): Agent[] {
  return [...(manifest.agents ?? DEFAULT_AGENTS)]
}

// A server goes to every agent its manifest manages unless it names fewer.
export function agentsFor(server: ManifestServer, manifest: Manifest): Agent[] {
  return server.agents ?? manifestAgents(manifest)
}

function readAgents(value: unknown, file: string): Agent[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`${file}: agents must be a non-empty list`)
  }
  const agents: Agent[] = []
  for (const agent of value) {
    if (typeof agent !== "string" || !isAgent(agent)) {
      throw new Error(`${file}: unknown agent ${String(agent)}`)
    }
    agents.push(agent)
  }
  return agents
}

export function validateServer(
  server: unknown,
  where: string,
  allowed: readonly Agent[]
): asserts server is ManifestServer {
  if (!isRecord(server)) throw new Error(`${where} must be an object`)
  const transport = server.transport
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    throw new Error(`${where} needs transport "stdio", "http", or "sse"`)
  }
  if (transport === "stdio" && typeof server.command !== "string") {
    throw new Error(`${where} needs a command`)
  }
  if (transport !== "stdio" && typeof server.url !== "string") {
    throw new Error(`${where} needs a url`)
  }
  if (server.agents === undefined) return
  if (!Array.isArray(server.agents)) throw new Error(`${where}: agents must be a list`)
  const outside = server.agents.filter(
    (agent) => typeof agent !== "string" || !isAgent(agent) || !allowed.includes(agent)
  )
  if (outside.length) {
    throw new Error(
      `${where} lists ${outside.join(", ")}, which the manifest does not manage. Its agents are ${allowed.join(", ")}.`
    )
  }
}
