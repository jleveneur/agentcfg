import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fromJsonServer, readJson, toClaude, toCursor, upsertJsonServers, writeJson } from "./json-config.js";
import { isManagedServer, readCodexServers, upsertCodexMcp } from "./toml.js";

export async function readAgentServers(agent, file) {
  if (agent === "codex") {
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return {};
      throw error;
    }
    return readCodexServers(text);
  }

  const data = await readJson(file);
  const servers = {};
  for (const [name, raw] of Object.entries(data.mcpServers ?? {})) {
    const server = fromJsonServer(raw);
    if (server) servers[name] = server;
  }
  return servers;
}

export async function writeAgentServers(agent, file, entries, options = {}) {
  if (agent === "codex") {
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    const next = upsertCodexMcp(text, entries, options);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next);
    return;
  }

  const data = await readJson(file);
  const encode = agent === "claude" ? toClaude : toCursor;
  await writeJson(file, upsertJsonServers(data, entries, { ...options, encode }));
}

export function secretFields(server) {
  const fields = [];
  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (isLiteralSecret(value)) fields.push(`env.${key}`);
  }
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (isLiteralSecret(value)) fields.push(`headers.${key}`);
  }
  return fields;
}

export function isLiteralSecret(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  return !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) && !/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export { isManagedServer };
