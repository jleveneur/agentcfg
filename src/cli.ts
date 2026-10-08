import { readFileSync } from "node:fs"
import { basename, relative, resolve } from "node:path"

import {
  addServer,
  type CommandOptions,
  diffConfigs,
  importConfigs,
  initManifest,
  removeServer,
  syncConfigs
} from "./commands.ts"
import { linkSkills } from "./link.ts"
import { createContext, posix, tildify } from "./paths.ts"
import { formatDiff, formatScan, formatStatus } from "./report.ts"
import { groupFindings, scan } from "./scan.ts"
import { collectStatus } from "./status.ts"

export interface IO {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const defaultIO: IO = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`)
}

export function version(): string {
  // package.json sits next to src/ and dist/ alike.
  const text = readFileSync(new URL("../package.json", import.meta.url), "utf8")
  const data: unknown = JSON.parse(text)
  return typeof data === "object" && data && "version" in data ? String(data.version) : "unknown"
}

export async function run(argv: string[], io: IO = defaultIO): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed.version) {
    io.stdout(version())
    return 0
  }
  if (parsed.help || !parsed.command || parsed.command === "help") {
    io.stdout(helpText())
    return 0
  }

  const ctx = createContext({ home: parsed.home })
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
    from: parsed.from
  }
  const would = options.dryRun ? "Would write" : "Wrote"

  switch (parsed.command) {
    case "scan": {
      const projects = parsed.projects ? resolve(parsed.projects) : null
      const result = await scan({ ctx, projects, cwd: parsed.home ? undefined : options.dir })
      io.stdout(
        parsed.json
          ? JSON.stringify({ ...result, groups: groupFindings(result.findings) }, null, 2)
          : formatScan(result, ctx.home, { all: parsed.all })
      )
      return 0
    }

    case "status": {
      const status = await collectStatus(options)
      if (parsed.json) io.stdout(JSON.stringify(status, null, 2))
      else io.stdout(formatStatus(status, ctx.home))
      const broken = status.rows.some((row) =>
        Object.values(row.cells).some((cell) => cell.state === "missing" || cell.state === "failed")
      )
      return broken ? 1 : 0
    }

    case "init": {
      const result = await initManifest(options)
      io.stdout(`${would} ${tildify(result.scope.manifest, ctx.home)}`)
      return 0
    }

    case "import": {
      const result = await importConfigs(options)
      for (const warning of result.warnings) io.stderr(warning)
      for (const conflict of result.conflicts) {
        const agents = conflict.entries.map((entry) => entry.agent).join(", ")
        io.stderr(
          `${conflict.name}: conflicting definitions in ${agents}. Pass --prefer <agent> to choose one.`
        )
      }
      const count = Object.keys(result.manifest.servers).length
      io.stdout(
        `${would} ${tildify(result.scope.manifest, ctx.home)} (${count} server${count === 1 ? "" : "s"})`
      )
      return result.conflicts.length ? 2 : 0
    }

    case "add": {
      const [name, url, ...extra] = parsed.positional
      if (!name) {
        throw new Error("Usage: agentcfg add NAME URL, or agentcfg add NAME -- COMMAND ARGS...")
      }
      if (extra.length) {
        throw new Error(`Unexpected ${extra.join(" ")}. Put a command and its arguments after --.`)
      }
      const result = await addServer(options, {
        name,
        url,
        command: parsed.afterDashes,
        transport: parsed.transport,
        headers: parsed.headers,
        env: parsed.env
      })
      const verb = { added: "Added", replaced: "Replaced", unchanged: "Already had" }[result.status]
      const global = result.scope.kind === "global"
      io.stdout(
        `${verb} ${name} in ${tildify(result.scope.manifest, ctx.home)}. Run "${syncHint(global)}" to update the agent files.`
      )
      return 0
    }

    case "remove": {
      const [name] = parsed.positional
      if (!name) throw new Error("Usage: agentcfg remove NAME")
      const result = await removeServer(options, name)
      const global = result.scope.kind === "global"
      io.stdout(
        `Removed ${name} from ${tildify(result.scope.manifest, ctx.home)}. Run "${syncHint(global)} --prune" to remove it from the agent files.`
      )
      return 0
    }

    case "link": {
      const result = await linkSkills(options)
      const where = result.global ? "~" : basename(result.root)
      const show = (path: string) =>
        posix(result.global ? tildify(path, ctx.home) : relative(result.root, path))
      const verb = options.dryRun ? "Would link" : "Linked"
      const lines = result.actions.map((action) => {
        if (action.kind === "create-dir")
          return `  ${options.dryRun ? "would create" : "created"} ${show(action.path)}`
        if (action.kind === "link-dir" || action.kind === "link-skill") {
          return `  ${verb.toLowerCase()} ${show(action.path)} → ${posix(action.target ?? "")}`
        }
        if (action.kind === "remove-link") {
          return `  ${options.dryRun ? "would remove" : "removed"} ${show(action.path)}: ${action.reason ?? ""}`
        }
        return `  kept ${show(action.path)}: ${action.reason ?? ""}`
      })
      io.stdout([`Claude Code skills in ${where}:`, ...lines].join("\n"))
      const changed = result.actions.some((action) => action.kind !== "keep")
      if (changed && !options.dryRun) {
        io.stdout(
          result.global
            ? `Claude Code now sees the ${result.skills.length} skill${result.skills.length === 1 ? "" : "s"} in ~/.agents/skills. Run agentcfg link --global again after adding one.`
            : `Claude Code now sees the skills in .agents/skills. Commit .claude/skills so the rest of the team gets them too.`
        )
      }
      return 0
    }

    case "diff": {
      const result = await diffConfigs(options)
      for (const warning of result.warnings) io.stderr(warning)
      io.stdout(formatDiff(result.rows))
      return result.rows.some((row) => row.status === "missing" || row.status === "different")
        ? 1
        : 0
    }

    case "sync": {
      const result = await syncConfigs(options)
      for (const warning of result.warnings) io.stderr(warning)
      io.stdout(formatDiff(result.rows))
      if (options.dryRun) {
        const extras = result.rows.filter((row) => row.status === "extra" && !row.managed)
        if (options.prune && extras.length) {
          io.stdout(
            `--prune would remove: ${extras.map((row) => `${row.agent} ${row.name}`).join(", ")}`
          )
        }
        return 0
      }
      io.stdout(
        result.wrote.length
          ? `Updated ${result.wrote.map((file) => tildify(file, ctx.home)).join(", ")}`
          : "Nothing to update."
      )
      if (result.removed.length) io.stdout(`Removed ${result.removed.join(", ")}`)
      if (result.backup) {
        io.stdout(`Previous files saved in ${tildify(result.backup.dir, ctx.home)}`)
      }
      return 0
    }

    default:
      throw new Error(`Unknown command: ${parsed.command}. Run agentcfg --help.`)
  }
}

function syncHint(global: boolean): string {
  return `agentcfg sync${global ? " --global" : ""}`
}

interface Parsed {
  command?: string
  positional: string[]
  afterDashes?: string[]
  transport?: string
  headers: string[]
  env: string[]
  agents?: string[]
  home?: string
  project?: string
  projects?: string
  manifest?: string
  prefer?: string
  from?: string
  global: boolean
  force: boolean
  includeManaged: boolean
  prune: boolean
  dryRun: boolean
  json: boolean
  all: boolean
  help: boolean
  version: boolean
}

const FLAGS: Record<string, keyof Parsed> = {
  "--global": "global",
  "-g": "global",
  "--force": "force",
  "--include-managed": "includeManaged",
  "--prune": "prune",
  "--dry-run": "dryRun",
  "--json": "json",
  "--all": "all",
  "--help": "help",
  "-h": "help",
  "--version": "version",
  "-v": "version"
}

const VALUES: Record<
  string,
  "home" | "project" | "projects" | "manifest" | "prefer" | "transport" | "from"
> = {
  "--from": "from",
  "--home": "home",
  "--project": "project",
  "--projects": "projects",
  "--manifest": "manifest",
  "--prefer": "prefer",
  "--transport": "transport"
}

function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = {
    positional: [],
    headers: [],
    env: [],
    global: false,
    force: false,
    includeManaged: false,
    prune: false,
    dryRun: false,
    json: false,
    all: false,
    help: false,
    version: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ""
    const flag = FLAGS[token]
    if (token === "--") {
      parsed.afterDashes = argv.slice(index + 1)
      break
    } else if (flag) {
      Object.assign(parsed, { [flag]: true })
    } else if (VALUES[token]) {
      index += 1
      parsed[VALUES[token]] = required(argv, index, token)
    } else if (token === "--header") {
      index += 1
      parsed.headers.push(required(argv, index, token))
    } else if (token === "--env") {
      index += 1
      parsed.env.push(required(argv, index, token))
    } else if (token === "--agent") {
      index += 1
      parsed.agents = required(argv, index, token)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown argument: ${token}`)
    } else if (parsed.command) {
      parsed.positional.push(token)
    } else {
      parsed.command = token
    }
  }
  return parsed
}

function required(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`)
  return value
}

function helpText(): string {
  return `agentcfg ${version()} — one MCP config for Cursor, Claude Code, Codex, VS Code, and Gemini CLI

Usage:
  agentcfg scan   [--projects DIR] [--all] [--json]
  agentcfg status [--from AGENT] [--json]
  agentcfg init   [--global] [--agent LIST] [--force]
  agentcfg add    NAME URL [--header 'KEY: VALUE'] [--transport sse] [--agent LIST] [--global] [--force]
  agentcfg add    NAME [--env 'KEY=VALUE'] [--agent LIST] [--global] [--force] -- COMMAND ARGS...
  agentcfg remove NAME [--global]
  agentcfg link   [--global] [--dry-run]
  agentcfg import [--global] [--agent LIST] [--prefer AGENT] [--include-managed] [--force]
  agentcfg diff   [--global] [--from AGENT] [--agent LIST]
  agentcfg sync   [--global] [--from AGENT] [--agent LIST] [--prune] [--dry-run]

Two manifests with the same shape:
  global   ~/.config/agentcfg/agentcfg.json: servers for every project
  project  agentcfg.json at the project root, found from the current directory up

Commands work on the project manifest unless you pass --global. A manifest
writes to cursor, claude, and codex unless its "agents" list says otherwise;
vscode and gemini are also supported.

scan     lists every MCP server on this machine, plugins included. Read-only.
         Projects come from --projects, the current directory, and the ones
         Claude Code, Codex, and Cursor know. --all also lists what Cursor
         kept from servers removed since.
status   asks the cursor-agent, claude, and codex CLIs which servers are ready,
         need a login, or wait for approval.
init     creates an empty manifest. --agent picks the agents it writes to.
add      adds a server to the manifest, creating ./agentcfg.json if needed.
         Write secrets as \${NAME}, in single quotes so the shell keeps them.
remove   removes a server from the manifest.
link     lets Claude Code see the skills in .agents/skills, the folder Codex,
         Cursor, Gemini CLI, and VS Code read: one .claude/skills link in a
         project, or one link per skill in ~/.claude/skills with --global.
import   reads the agent files of the scope into its manifest.
sync     writes the manifest into the agent files. With --from AGENT, that
         agent's own file is the source instead, with no agentcfg.json:
         --from claude reads .mcp.json (or ~/.claude.json with --global). Every changed file is first
         copied to ~/.local/state/agentcfg/backups.

--agent LIST is a comma-separated list of cursor, claude, codex, vscode, gemini.
For add, it limits the server to those agents; elsewhere, the command.

Other options: --project DIR to start from another directory, --manifest FILE
to use another manifest, --home DIR to read and write under another home,
--version.
`
}
