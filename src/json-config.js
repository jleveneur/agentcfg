import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function toCursor(server) {
  if (server.transport === "stdio") {
    return compact({
      command: server.command,
      args: server.args,
      env: server.env,
    });
  }
  return compact({
    url: server.url,
    headers: server.headers,
  });
}

export function toClaude(server) {
  if (server.transport === "stdio") {
    return compact({
      command: server.command,
      args: server.args,
      env: server.env,
    });
  }
  return compact({
    type: server.transport,
    url: server.url,
    headers: server.headers,
  });
}

export function fromJsonServer(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.url === "string") {
    return compact({
      transport: raw.type === "sse" ? "sse" : "http",
      url: raw.url,
      headers: emptyObject(raw.headers) ? undefined : raw.headers,
    });
  }
  if (typeof raw.command === "string") {
    return compact({
      transport: "stdio",
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args : undefined,
      env: emptyObject(raw.env) ? undefined : raw.env,
    });
  }
  return null;
}

export function upsertJsonServers(data, entries, { prune = false, encode }) {
  const next = { ...data };
  const current = { ...(data.mcpServers ?? {}) };
  const names = new Set(entries.map((entry) => entry.name));
  if (prune) {
    for (const name of Object.keys(current)) {
      if (!names.has(name)) delete current[name];
    }
  }
  for (const entry of entries) current[entry.name] = encode(entry.server);
  next.mcpServers = current;
  return next;
}

function compact(server) {
  return Object.fromEntries(
    Object.entries(server).filter(([, value]) => value != null && !(Array.isArray(value) && value.length === 0) && !emptyObject(value)),
  );
}

function emptyObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}
