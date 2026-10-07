const HEADER = /^\s*\[(.+)\]\s*(?:#.*)?$/;

export function splitToml(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const preamble = [];
  const sections = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(HEADER);
    if (match) {
      current = { name: match[1].trim(), lines: [line] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }

  return { preamble, sections };
}

export function mcpServerName(sectionName) {
  const parts = sectionName.split(".");
  if (parts[0] !== "mcp_servers" || parts.length < 2 || !parts[1]) return null;
  return parts[1];
}

export function parseSimpleAssignments(lines) {
  const values = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = parseTomlValue(match[2].trim());
  }
  return values;
}

export function readCodexServers(text) {
  const { sections } = splitToml(text);
  const grouped = new Map();

  for (const section of sections) {
    const name = mcpServerName(section.name);
    if (!name) continue;
    const nested = section.name.split(".").slice(2).join(".");
    if (!grouped.has(name)) grouped.set(name, { top: {}, env: {} });
    const bucket = grouped.get(name);
    const values = parseSimpleAssignments(section.lines);
    if (nested === "env") bucket.env = values;
    else if (nested === "") bucket.top = values;
  }

  const servers = {};
  for (const [name, { top, env }] of grouped) {
    const server = fromCodex(top, env);
    if (server) servers[name] = server;
  }
  return servers;
}

export function renderCodexServer(name, server) {
  const lines = [`[mcp_servers.${name}]`];
  if (server.transport === "stdio") {
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args?.length) lines.push(`args = ${tomlArray(server.args)}`);
    if (server.cwd) lines.push(`cwd = ${tomlString(server.cwd)}`);
    if (server.startupTimeoutSec != null) {
      lines.push(`startup_timeout_sec = ${Number(server.startupTimeoutSec)}`);
    }
  } else {
    lines.push(`url = ${tomlString(server.url)}`);
    if (server.bearerTokenEnvVar) {
      lines.push(`bearer_token_env_var = ${tomlString(server.bearerTokenEnvVar)}`);
    }
  }
  if (server.enabled === false) lines.push("enabled = false");

  const blocks = [lines.join("\n")];
  if (server.transport === "stdio" && server.env && Object.keys(server.env).length) {
    const envLines = [`[mcp_servers.${name}.env]`];
    for (const [key, value] of Object.entries(server.env)) {
      envLines.push(`${key} = ${tomlString(value)}`);
    }
    blocks.push(envLines.join("\n"));
  }
  return blocks.join("\n\n");
}

export function upsertCodexMcp(text, servers, { prune = false } = {}) {
  const { preamble, sections } = splitToml(text);
  const names = new Set(servers.map((entry) => entry.name));
  const kept = sections.filter((section) => {
    const name = mcpServerName(section.name);
    if (!name) return true;
    if (names.has(name)) return false;
    if (prune && !sectionLooksManaged(section)) return false;
    return true;
  });

  const extra = servers.map((entry) => renderCodexServer(entry.name, entry.server)).join("\n\n");
  return joinToml(preamble, kept, extra);
}

function sectionLooksManaged(section) {
  return isManagedServer({ command: section.lines.join("\n"), cwd: "" });
}

export function isManagedServer(server) {
  const haystack = `${server.command ?? ""}\n${server.cwd ?? ""}`;
  return /ChatGPT\.app|\/\.codex\/plugins\/|Computer Use\.app|Codex Computer Use/.test(haystack);
}

function joinToml(preamble, sections, extra) {
  const chunks = [];
  const pre = preamble.join("\n").replace(/\s+$/, "");
  if (pre) chunks.push(pre);
  for (const section of sections) {
    const body = section.lines.join("\n").replace(/\s+$/, "");
    if (body) chunks.push(body);
  }
  if (extra) chunks.push(extra.replace(/\s+$/, ""));
  return chunks.length ? `${chunks.join("\n\n")}\n` : "";
}

function fromCodex(top, env) {
  if (typeof top.url === "string") {
    return clean({
      transport: "http",
      url: top.url,
      bearerTokenEnvVar: top.bearer_token_env_var,
      enabled: top.enabled === false ? false : undefined,
    });
  }
  if (typeof top.command === "string") {
    return clean({
      transport: "stdio",
      command: top.command,
      args: Array.isArray(top.args) ? top.args : [],
      env,
      cwd: top.cwd,
      enabled: top.enabled === false ? false : undefined,
      startupTimeoutSec: top.startup_timeout_sec,
    });
  }
  return null;
}

function clean(server) {
  const out = { transport: server.transport };
  if (server.url) out.url = server.url;
  if (server.command) out.command = server.command;
  if (server.args?.length) out.args = server.args;
  if (server.env && Object.keys(server.env).length) out.env = server.env;
  if (server.headers && Object.keys(server.headers).length) out.headers = server.headers;
  if (server.bearerTokenEnvVar) out.bearerTokenEnvVar = server.bearerTokenEnvVar;
  if (server.cwd) out.cwd = server.cwd;
  if (server.startupTimeoutSec != null) out.startupTimeoutSec = server.startupTimeoutSec;
  if (server.enabled === false) out.enabled = false;
  return out;
}

export function tomlString(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")}"`;
}

function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

function parseTomlValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith("[")) return parseStringArray(raw);
  if (raw.startsWith('"')) return parseQuoted(raw);
  return raw;
}

function parseQuoted(raw) {
  const { value } = parseStringAt(raw, 0);
  return value;
}

function parseStringArray(raw) {
  const trimmed = raw.trim();
  if (!trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const values = [];
  let index = 0;
  while (index < inner.length) {
    while (index < inner.length && (inner[index] === " " || inner[index] === ",")) index += 1;
    if (index >= inner.length) break;
    if (inner[index] !== '"') break;
    const parsed = parseStringAt(inner, index);
    values.push(parsed.value);
    index = parsed.next;
  }
  return values;
}

function parseStringAt(input, start) {
  let value = "";
  let index = start + 1;
  while (index < input.length) {
    const char = input[index];
    if (char === "\\") {
      const next = input[index + 1];
      if (next === "n") value += "\n";
      else if (next === "t") value += "\t";
      else value += next ?? "";
      index += 2;
      continue;
    }
    if (char === '"') return { value, next: index + 1 };
    value += char;
    index += 1;
  }
  return { value, next: index };
}
