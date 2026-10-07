import { basename } from "node:path"

import type { DiffRow } from "./commands.ts"
import { tildify } from "./paths.ts"
import { type Finding, groupFindings, type LoadedOnly, type ScanResult } from "./scan.ts"
import { type State, STATUS_AGENTS, type StatusAgent, type StatusReport } from "./status.ts"
import type { Server } from "./types.ts"

export function formatDiff(rows: DiffRow[]): string {
  if (!rows.length) return "No MCP servers."
  return rows
    .map((row) => {
      const place = `${row.label}  ${row.agent}  ${row.name}`
      if (row.status === "same") return `${place}  in sync`
      if (row.status === "missing") return `${place}  missing`
      if (row.status === "extra")
        return `${place}  only in the agent${row.managed ? " (managed, left untouched)" : ""}`
      return `${place}  differs\n  manifest: ${describe(row.expected)}\n  ${row.agent}: ${describe(row.actual)}`
    })
    .join("\n")
}

const LIVE_REASON: Record<LoadedOnly["origin"], string> = {
  extension: "added by an IDE extension",
  user: "not in ~/.cursor/mcp.json",
  project: "not in the project's .cursor/mcp.json",
  plugin: "not in the plugin's current version"
}

const STALE_REASON: Record<LoadedOnly["origin"], string> = {
  extension: "added by an IDE extension",
  user: "removed from ~/.cursor/mcp.json",
  project: "removed from the project's .cursor/mcp.json",
  plugin: "from a removed or updated plugin"
}

function loadedRow(entry: LoadedOnly, reasons: Record<LoadedOnly["origin"], string>): string[] {
  const count = entry.workspaces.length
  return [
    entry.id,
    reasons[entry.origin],
    `${count} workspace${count === 1 ? "" : "s"}`,
    `last loaded ${new Date(entry.lastSeen).toLocaleDateString("en-CA")}`
  ]
}

export function formatScan(
  result: ScanResult,
  home: string,
  options: { all?: boolean } = {}
): string {
  const groups = groupFindings(result.findings)
  const repeated = groups.filter((group) => group.findings.length > 1).length
  const lines = [
    `${result.findings.length} definitions of ${groups.length} distinct MCP servers, ${repeated} defined in more than one place.`,
    `Projects scanned: ${result.projects.length}. Secrets are masked.`
  ]

  for (const group of groups) {
    lines.push("", `${group.identity}${group.names.length ? `  (${group.names.join(", ")})` : ""}`)
    const rows = group.findings.map((finding) => [
      finding.agent,
      finding.scope,
      where(finding, home),
      flags(finding, group.names.length > 1),
      tildify(finding.file, home)
    ])
    lines.push(...table(rows).map((line) => `  ${line}`))
  }

  const live = result.loadedOnly.filter((entry) => !entry.stale)
  const stale = result.loadedOnly.filter((entry) => entry.stale)
  if (live.length) {
    lines.push("", "Loaded by Cursor, but no config file defines them:")
    lines.push(
      ...table(live.map((entry) => loadedRow(entry, LIVE_REASON))).map((line) => `  ${line}`)
    )
  }
  if (stale.length && options.all) {
    lines.push("", "Left over in Cursor's workspace snapshots, from servers removed since:")
    lines.push(
      ...table(stale.map((entry) => loadedRow(entry, STALE_REASON))).map((line) => `  ${line}`)
    )
  } else if (stale.length) {
    lines.push(
      "",
      `${stale.length} more entr${stale.length === 1 ? "y" : "ies"} in Cursor's workspace snapshots ${stale.length === 1 ? "comes" : "come"} from servers removed since those workspaces were last opened. Cursor drops them when you reopen the workspace; agentcfg scan --all lists them.`
    )
  }

  if (result.warnings.length)
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `  ${warning}`))
  return lines.join("\n")
}

function where(finding: Finding, home: string): string {
  if (finding.scope === "plugin") return finding.plugin ?? ""
  if (finding.project)
    return finding.scope === "local"
      ? `${basename(finding.project)} (private)`
      : basename(finding.project)
  return tildify("~", home)
}

function flags(finding: Finding, showName: boolean): string {
  const out: string[] = []
  if (showName) out.push(`"${finding.name}"`)
  if (finding.installedIn) {
    const projects = finding.installedIn
      .filter((place) => place !== "everywhere")
      .map((place) => basename(place))
    if (finding.installedIn.includes("everywhere")) out.push("installed for every project")
    if (projects.length) out.push(`on in ${projects.join(", ")}`)
    if (!finding.installedIn.length) out.push("cached, not installed")
  } else if (!finding.enabled) out.push("disabled")
  if (finding.alsoLoadedBy?.length) out.push(`also loaded by ${finding.alsoLoadedBy.join(", ")}`)
  if (finding.managed) out.push("app-managed")
  if (finding.loadedIn?.length)
    out.push(
      `loaded in ${finding.loadedIn.length} Cursor workspace${finding.loadedIn.length === 1 ? "" : "s"}`
    )
  return out.join(", ")
}

function table(rows: string[][]): string[] {
  const widths = rows.reduce<number[]>(
    (acc, row) => row.map((cell, index) => Math.max(acc[index] ?? 0, cell.length)),
    []
  )
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd()
  )
}

function describe(server?: Server): string {
  if (!server) return ""
  if (server.transport === "stdio")
    return `${server.command} ${(server.args ?? []).join(" ")}`.trim()
  return server.url ?? ""
}

const STATE_LABEL: Record<State, string> = {
  ready: "ready",
  configured: "configured",
  "needs-login": "needs login",
  "needs-approval": "needs approval",
  disabled: "disabled",
  failed: "failed",
  missing: "missing",
  untrusted: "not trusted",
  unknown: "?"
}

export function formatStatus(status: StatusReport, home: string): string {
  const lines = [
    status.project
      ? `Project ${basename(status.project)} (${tildify(status.project, home)})`
      : `No project manifest here. Showing global servers, as seen from ${tildify(status.dir, home)}.`
  ]
  const missingCli = status.reports.filter((cli) => !cli.available).map((cli) => cli.agent)
  if (missingCli.length) lines.push(`Not installed: ${missingCli.join(", ")}.`)

  if (status.rows.length) {
    const header = ["server", "from", ...STATUS_AGENTS]
    const body = status.rows.map((row) => [
      row.name,
      row.from,
      ...STATUS_AGENTS.map((agent) => {
        const cell = row.cells[agent]
        return cell ? STATE_LABEL[cell.state] : "-"
      })
    ])
    lines.push("", ...table([header, ...body]))
  } else {
    lines.push("", "No servers in agentcfg manifests.")
  }

  if (status.others.length) {
    lines.push("", "Reported by the agents, not in agentcfg:")
    lines.push(
      ...table(
        status.others.map((other) => [other.agent, other.name, STATE_LABEL[other.status.state]])
      ).map((line) => `  ${line}`)
    )
  }
  if (status.connectors.length) {
    lines.push(
      "",
      `Claude Code also loads ${status.connectors.length} claude.ai connectors: ${status.connectors.join(", ")}.`
    )
  }

  const hints = statusHints(status)
  if (hints.length) lines.push("", "To do:", ...hints.map((hint) => `  ${hint}`))
  return lines.join("\n")
}

function statusHints(status: StatusReport): string[] {
  const names = (agent: StatusAgent, state: State) =>
    status.rows.filter((row) => row.cells[agent]?.state === state).map((row) => row.name)
  const hints: string[] = []
  const add = (list: string[], text: (list: string) => string) => {
    if (list.length) hints.push(text(list.join(", ")))
  }
  add(
    names("cursor", "needs-login"),
    (list) =>
      `cursor: log in to ${list} in Cursor › Settings › MCP, or run cursor-agent mcp login NAME`
  )
  add(
    names("cursor", "needs-approval"),
    (list) => `cursor: approve ${list} when Cursor asks, or run cursor-agent mcp enable NAME`
  )
  add(
    names("claude", "needs-login"),
    (list) => `claude: run /mcp in Claude Code to log in to ${list}`
  )
  add(
    names("claude", "needs-approval"),
    (list) => `claude: start claude in the project and approve ${list}`
  )
  add(names("codex", "needs-login"), (list) => `codex: codex mcp login NAME for ${list}`)
  add(
    names("codex", "untrusted"),
    (list) => `codex: trust this project in Codex so it loads ${list}`
  )
  for (const agent of STATUS_AGENTS) {
    add(
      names(agent, "missing"),
      (list) => `${agent}: ${list} not loaded. Run agentcfg sync, then restart ${agent}`
    )
  }
  return hints
}
