import type { Backup } from "./backup.ts";
import { readCodexServers, upsertCodexMcp } from "./codex-toml.ts";
import { readJson, readText, writeFileAtomic, writeJson } from "./files.ts";
import { fromJsonServers, toClaude, toCursor } from "./servers.ts";
import type { Agent, Server, ServerMap } from "./types.ts";

export async function readAgentServers(agent: Agent, file: string): Promise<ServerMap> {
  if (agent === "codex") {
    const text = await readText(file);
    return text ? readCodexServers(text, file) : {};
  }
  return fromJsonServers((await readJson(file)).mcpServers);
}

export interface WriteOptions {
  prune?: boolean;
  backup?: Backup;
}

export interface WriteResult {
  changed: boolean;
  removed: string[];
}

export async function writeAgentServers(
  agent: Agent,
  file: string,
  entries: { name: string; server: Server }[],
  { prune = false, backup }: WriteOptions = {},
): Promise<WriteResult> {
  if (agent === "codex") {
    const text = (await readText(file)) ?? "";
    const next = upsertCodexMcp(text, entries, { prune });
    if (next.text === text) return { changed: false, removed: [] };
    await backup?.save(file);
    await writeFileAtomic(file, next.text);
    return { changed: true, removed: next.removed };
  }

  const data = await readJson(file);
  const encode = agent === "claude" ? toClaude : toCursor;
  const current = { ...((data.mcpServers as Record<string, unknown> | undefined) ?? {}) };
  const names = new Set(entries.map((entry) => entry.name));
  const removed = prune ? Object.keys(current).filter((name) => !names.has(name)) : [];
  for (const name of removed) delete current[name];
  for (const entry of entries) current[entry.name] = encode(entry.server);
  const next = { ...data, mcpServers: current };
  if (JSON.stringify(next) === JSON.stringify(data)) return { changed: false, removed: [] };
  await backup?.save(file);
  await writeJson(file, next);
  return { changed: true, removed };
}
