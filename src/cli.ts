import { resolve } from "node:path";
import { type CommandOptions, diffConfigs, importConfigs, syncConfigs } from "./commands.ts";
import { createContext, tildify } from "./paths.ts";
import { formatDiff, formatScan } from "./report.ts";
import { groupFindings, scan } from "./scan.ts";

export interface IO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function run(argv: string[], io: IO = { stdout: console.log, stderr: console.error }): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.help || !parsed.command || parsed.command === "help") {
    io.stdout(helpText());
    return 0;
  }

  const ctx = createContext({ home: parsed.home });
  const options: CommandOptions = {
    ctx,
    projects: parsed.noProjects || !parsed.projects ? null : resolve(parsed.projects),
    manifest: resolve(parsed.manifest ?? "agentcfg.json"),
    agents: parsed.agents,
    prefer: parsed.prefer,
    includeManaged: parsed.includeManaged,
    prune: parsed.prune,
    dryRun: parsed.dryRun,
  };

  if (parsed.command === "scan") {
    const result = await scan({ ctx, projects: options.projects, cwd: parsed.home ? undefined : process.cwd() });
    if (parsed.json) {
      io.stdout(JSON.stringify({ ...result, groups: groupFindings(result.findings) }, null, 2));
    } else {
      io.stdout(formatScan(result, ctx.home));
    }
    return 0;
  }

  if (parsed.command === "import") {
    const result = await importConfigs(options);
    for (const warning of result.warnings) io.stderr(warning);
    for (const conflict of result.conflicts) {
      const agents = conflict.entries.map((entry) => entry.agent).join(", ");
      io.stderr(`${conflict.label} ${conflict.name}: conflicting definitions in ${agents}. Pass --prefer <agent> to choose one.`);
    }
    const globalCount = Object.keys(result.manifest.servers).length;
    const projectCount = Object.values(result.manifest.projects).reduce((count, servers) => count + Object.keys(servers).length, 0);
    io.stdout(`${options.dryRun ? "Would write" : "Wrote"} ${options.manifest} (${globalCount} global, ${projectCount} project)`);
    return result.conflicts.length ? 2 : 0;
  }

  if (parsed.command === "diff") {
    const result = await diffConfigs(options);
    io.stdout(formatDiff(result.rows));
    return result.rows.some((row) => row.status === "missing" || row.status === "different") ? 1 : 0;
  }

  if (parsed.command === "sync") {
    const result = await syncConfigs(options);
    io.stdout(formatDiff(result.rows));
    if (options.dryRun) {
      const extras = result.rows.filter((row) => row.status === "extra" && !row.managed);
      if (options.prune && extras.length) {
        io.stdout(`--prune would remove: ${extras.map((row) => `${row.label} ${row.agent} ${row.name}`).join(", ")}`);
      }
      return 0;
    }
    io.stdout(result.wrote.length ? `Updated ${result.wrote.join(", ")}` : "Nothing to update.");
    if (result.removed.length) io.stdout(`Removed ${result.removed.join(", ")}`);
    if (result.backup) io.stdout(`Previous files saved in ${tildify(result.backup.dir, ctx.home)}`);
    return 0;
  }

  throw new Error(`Unknown command: ${parsed.command}`);
}

interface Parsed {
  command?: string;
  agents?: string[];
  home?: string;
  projects?: string;
  manifest?: string;
  prefer?: string;
  includeManaged: boolean;
  prune: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
  noProjects: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const first = argv[0];
  if (first === "--help" || first === "-h") return { ...parseArgs(argv.slice(1)), command: undefined, help: true };
  const parsed: Parsed = {
    command: first,
    includeManaged: false,
    prune: false,
    dryRun: false,
    json: false,
    help: false,
    noProjects: false,
  };
  const rest = argv.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (token === "--help" || token === "-h") parsed.help = true;
    else if (token === "--include-managed") parsed.includeManaged = true;
    else if (token === "--prune") parsed.prune = true;
    else if (token === "--dry-run") parsed.dryRun = true;
    else if (token === "--json") parsed.json = true;
    else if (token === "--no-projects") parsed.noProjects = true;
    else if (token === "--home") parsed.home = required(rest, ++index, token);
    else if (token === "--projects") parsed.projects = required(rest, ++index, token);
    else if (token === "--manifest") parsed.manifest = required(rest, ++index, token);
    else if (token === "--prefer") parsed.prefer = required(rest, ++index, token);
    else if (token === "--agent") {
      parsed.agents = required(rest, ++index, token)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return parsed;
}

function required(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

function helpText(): string {
  return `agentcfg — one MCP manifest for Cursor, Claude Code, and Codex

Usage:
  agentcfg scan   [--projects DIR] [--json]
  agentcfg import [--projects DIR] [--no-projects] [--manifest FILE] [--prefer cursor|claude|codex] [--include-managed]
  agentcfg diff   [--manifest FILE] [--agent cursor,claude,codex]
  agentcfg sync   [--manifest FILE] [--agent cursor,claude,codex] [--prune] [--dry-run]

scan lists every MCP server on this machine: user and project files, Claude
Code's private per-project servers, and the servers shipped by Cursor, Claude
Code, and Codex plugins. It only reads, and masks secrets.

import reads the global configs into agentcfg.json. Pass --projects DIR to also
read the directories inside DIR.

sync writes the manifest back. Global servers go to ~/.cursor/mcp.json,
~/.claude.json, and ~/.codex/config.toml. Project servers go to .cursor/mcp.json,
.mcp.json, and .codex/config.toml inside each project. Every file is copied to
~/.local/state/agentcfg/backups before it changes.

All commands accept --home DIR to read and write under another home directory.
`;
}
