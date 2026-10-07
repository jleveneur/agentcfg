import { resolve } from "node:path";
import { addPresets, type CommandOptions, diffConfigs, importConfigs, syncConfigs } from "./commands.ts";
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
    dir: resolve(parsed.project ?? process.cwd()),
    global: parsed.global,
    manifest: parsed.manifest,
    agents: parsed.agents,
    prefer: parsed.prefer,
    includeManaged: parsed.includeManaged,
    prune: parsed.prune,
    dryRun: parsed.dryRun,
    force: parsed.force,
  };
  const would = options.dryRun ? "Would write" : "Wrote";

  if (parsed.command === "scan") {
    const projects = parsed.projects ? resolve(parsed.projects) : null;
    const result = await scan({ ctx, projects, cwd: parsed.home ? undefined : options.dir });
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
      io.stderr(`${conflict.name}: conflicting definitions in ${agents}. Pass --prefer <agent> to choose one.`);
    }
    const count = Object.keys(result.manifest.servers).length;
    io.stdout(`${would} ${tildify(result.scope.manifest, ctx.home)} (${count} server${count === 1 ? "" : "s"})`);
    return result.conflicts.length ? 2 : 0;
  }

  if (parsed.command === "add") {
    const result = await addPresets(options, parsed.positional);
    if (result.added.length) io.stdout(`Added ${result.added.join(", ")}`);
    if (result.skipped.length) {
      io.stderr(`Kept the project's own ${result.skipped.join(", ")}. Pass --force to replace them with the preset.`);
    }
    io.stdout(`${would} ${tildify(result.file, ctx.home)}. Run "agentcfg sync" to update the agent files.`);
    return 0;
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
        io.stdout(`--prune would remove: ${extras.map((row) => `${row.agent} ${row.name}`).join(", ")}`);
      }
      return 0;
    }
    io.stdout(result.wrote.length ? `Updated ${result.wrote.map((file) => tildify(file, ctx.home)).join(", ")}` : "Nothing to update.");
    if (result.removed.length) io.stdout(`Removed ${result.removed.join(", ")}`);
    if (result.backup) io.stdout(`Previous files saved in ${tildify(result.backup.dir, ctx.home)}`);
    return 0;
  }

  throw new Error(`Unknown command: ${parsed.command}`);
}

interface Parsed {
  command?: string;
  positional: string[];
  global: boolean;
  force: boolean;
  project?: string;
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
}

function parseArgs(argv: string[]): Parsed {
  const first = argv[0];
  if (first === "--help" || first === "-h") return { ...parseArgs(argv.slice(1)), command: undefined, help: true };
  const parsed: Parsed = {
    command: first,
    positional: [],
    global: false,
    force: false,
    includeManaged: false,
    prune: false,
    dryRun: false,
    json: false,
    help: false,
  };
  const rest = argv.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (token === "--help" || token === "-h") parsed.help = true;
    else if (token === "--include-managed") parsed.includeManaged = true;
    else if (token === "--prune") parsed.prune = true;
    else if (token === "--dry-run") parsed.dryRun = true;
    else if (token === "--json") parsed.json = true;
    else if (token === "--global" || token === "-g") parsed.global = true;
    else if (token === "--force") parsed.force = true;
    else if (token === "--project") parsed.project = required(rest, ++index, token);
    else if (token === "--home") parsed.home = required(rest, ++index, token);
    else if (token === "--projects") parsed.projects = required(rest, ++index, token);
    else if (token === "--manifest") parsed.manifest = required(rest, ++index, token);
    else if (token === "--prefer") parsed.prefer = required(rest, ++index, token);
    else if (token === "--agent") {
      parsed.agents = required(rest, ++index, token)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (!token.startsWith("-")) {
      parsed.positional.push(token);
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
  agentcfg add    <preset>... [--force]
  agentcfg import [--global] [--prefer cursor|claude|codex] [--include-managed] [--force]
  agentcfg diff   [--global] [--agent cursor,claude,codex]
  agentcfg sync   [--global] [--agent cursor,claude,codex] [--prune] [--dry-run]

Two manifests:
  global   ~/.config/agentcfg/agentcfg.json: servers for every project, and presets
  project  agentcfg.json at the project root, found from the current directory up

Commands work on the project manifest unless you pass --global.

scan     lists every MCP server on this machine, plugins included. Read-only.
add      copies presets from the global manifest into the project manifest.
import   reads the agent files of the scope into its manifest.
sync     writes the manifest into the agent files: ~/.cursor/mcp.json,
         ~/.claude.json, ~/.codex/config.toml for --global; .cursor/mcp.json,
         .mcp.json, .codex/config.toml in the project. Every changed file is
         copied to ~/.local/state/agentcfg/backups first.

Other options: --project DIR to start from another directory, --manifest FILE
to use another manifest, --home DIR to read and write under another home.
`;
}
