import { resolve } from "node:path";
import { diffConfigs, importConfigs, syncConfigs } from "./commands.js";

export async function run(argv, io = { stdout: console.log, stderr: console.error }) {
  const parsed = parseArgs(argv);
  if (parsed.help || !parsed.command || parsed.command === "help") {
    io.stdout(helpText());
    return 0;
  }

  const options = {
    home: parsed.home,
    projects: parsed.noProjects || !parsed.projects ? null : resolve(parsed.projects),
    manifest: resolve(parsed.manifest ?? "agentcfg.json"),
    agents: parsed.agents,
    prefer: parsed.prefer,
    includeManaged: parsed.includeManaged,
    prune: parsed.prune,
    dryRun: parsed.dryRun,
  };

  if (parsed.command === "import") {
    const result = await importConfigs(options);
    for (const warning of result.warnings) io.stderr(warning);
    for (const conflict of result.conflicts) {
      const agents = conflict.entries.map((entry) => entry.agent).join(", ");
      io.stderr(`${conflict.label} ${conflict.name}: conflicting definitions in ${agents}. Pass --prefer <agent> to choose one.`);
    }
    const globalCount = Object.keys(result.manifest.servers).length;
    const projectCount = Object.values(result.manifest.projects ?? {}).reduce(
      (count, servers) => count + Object.keys(servers).length,
      0,
    );
    io.stdout(
      `${options.dryRun ? "Would write" : "Wrote"} ${options.manifest} (${globalCount} global, ${projectCount} project)`,
    );
    return result.conflicts.length ? 2 : 0;
  }

  if (parsed.command === "diff" || parsed.command === "sync") {
    const result = parsed.command === "diff" ? await diffConfigs(options) : await syncConfigs(options);
    io.stdout(formatReport(result.rows));
    if (parsed.command === "sync" && !options.dryRun) {
      io.stdout(`Updated ${result.wrote.join(", ")}`);
    }
    const drifted = result.rows.some((row) => row.status === "missing" || row.status === "different");
    if (parsed.command === "diff") return drifted ? 1 : 0;
    return 0;
  }

  throw new Error(`Unknown command: ${parsed.command}`);
}

export function formatReport(rows) {
  if (!rows.length) return "No MCP servers.";
  return rows
    .map((row) => {
      const place = row.label ?? "global";
      if (row.status === "same") return `${place}  ${row.agent}  ${row.name}  in sync`;
      if (row.status === "missing") return `${place}  ${row.agent}  ${row.name}  missing`;
      if (row.status === "extra") {
        return `${place}  ${row.agent}  ${row.name}  only in the agent${row.managed ? " (managed, left untouched)" : ""}`;
      }
      return `${place}  ${row.agent}  ${row.name}  differs\n  manifest: ${describe(row.expected)}\n  ${row.agent}: ${describe(row.actual)}`;
    })
    .join("\n");
}

function describe(server) {
  if (server.transport === "stdio") return `${server.command} ${(server.args ?? []).join(" ")}`.trim();
  return server.url;
}

function parseArgs(argv) {
  const parsed = {
    command: argv[0],
    agents: undefined,
    includeManaged: false,
    prune: false,
    dryRun: false,
    help: false,
    noProjects: false,
  };
  const rest = argv.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--help" || token === "-h") parsed.help = true;
    else if (token === "--include-managed") parsed.includeManaged = true;
    else if (token === "--prune") parsed.prune = true;
    else if (token === "--dry-run") parsed.dryRun = true;
    else if (token === "--no-projects") parsed.noProjects = true;
    else if (token === "--home") parsed.home = required(rest, ++index, token);
    else if (token === "--projects") parsed.projects = required(rest, ++index, token);
    else if (token === "--manifest") parsed.manifest = required(rest, ++index, token);
    else if (token === "--prefer") parsed.prefer = required(rest, ++index, token);
    else if (token === "--agent") {
      parsed.agents = required(rest, ++index, token).split(",").map((item) => item.trim()).filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return parsed;
}

function required(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function helpText() {
  return `agentcfg — one MCP manifest for Cursor, Claude Code, and Codex

Usage:
  agentcfg import [--home DIR] [--projects DIR] [--no-projects] [--manifest FILE] [--prefer cursor|claude|codex] [--include-managed]
  agentcfg diff   [--home DIR] [--manifest FILE] [--agent cursor,claude,codex]
  agentcfg sync   [--home DIR] [--manifest FILE] [--agent cursor,claude,codex] [--prune] [--dry-run]

Global servers are written to the home configs. Project servers are written to
.cursor/mcp.json, .mcp.json, and .codex/config.toml inside each project.
import reads global configs. Pass --projects DIR to also scan the directories
inside DIR. A project copy of a server that already exists globally is kept
once, as the global server.
`;
}
