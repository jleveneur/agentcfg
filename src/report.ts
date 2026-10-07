import { basename } from "node:path";
import type { DiffRow } from "./commands.ts";
import { tildify } from "./paths.ts";
import { type Finding, groupFindings, type ScanResult } from "./scan.ts";
import type { Server } from "./types.ts";

export function formatDiff(rows: DiffRow[]): string {
  if (!rows.length) return "No MCP servers.";
  return rows
    .map((row) => {
      const place = `${row.label}  ${row.agent}  ${row.name}`;
      if (row.status === "same") return `${place}  in sync`;
      if (row.status === "missing") return `${place}  missing`;
      if (row.status === "extra") return `${place}  only in the agent${row.managed ? " (managed, left untouched)" : ""}`;
      return `${place}  differs\n  manifest: ${describe(row.expected)}\n  ${row.agent}: ${describe(row.actual)}`;
    })
    .join("\n");
}

export function formatScan(result: ScanResult, home: string): string {
  const groups = groupFindings(result.findings);
  const repeated = groups.filter((group) => group.findings.length > 1).length;
  const lines = [
    `${result.findings.length} definitions of ${groups.length} distinct MCP servers, ${repeated} defined in more than one place.`,
    `Projects scanned: ${result.projects.length}. Secrets are masked.`,
  ];

  for (const group of groups) {
    lines.push("", `${group.identity}${group.names.length ? `  (${group.names.join(", ")})` : ""}`);
    const rows = group.findings.map((finding) => [
      finding.agent,
      finding.scope,
      where(finding, home),
      flags(finding, group.names.length > 1),
      tildify(finding.file, home),
    ]);
    lines.push(...table(rows).map((line) => `  ${line}`));
  }

  if (result.loadedOnly.length) {
    lines.push("", "Loaded by Cursor, but no config file defines them:");
    const rows = result.loadedOnly.map((entry) => [
      entry.id,
      {
        extension: "added by an IDE extension",
        user: "no longer in ~/.cursor/mcp.json",
        project: "no longer in the project's .cursor/mcp.json",
        plugin: "not in the plugin's current version",
      }[entry.origin],
      `${entry.workspaces.length} workspace${entry.workspaces.length === 1 ? "" : "s"}`,
    ]);
    lines.push(...table(rows).map((line) => `  ${line}`));
  }

  if (result.warnings.length) lines.push("", "Warnings:", ...result.warnings.map((warning) => `  ${warning}`));
  return lines.join("\n");
}

function where(finding: Finding, home: string): string {
  if (finding.scope === "plugin") return finding.plugin ?? "";
  if (finding.project) return finding.scope === "local" ? `${basename(finding.project)} (private)` : basename(finding.project);
  return tildify("~", home);
}

function flags(finding: Finding, showName: boolean): string {
  const out: string[] = [];
  if (showName) out.push(`"${finding.name}"`);
  if (!finding.enabled) out.push("disabled");
  if (finding.managed) out.push("app-managed");
  if (finding.loadedIn?.length) out.push(`loaded in ${finding.loadedIn.length} Cursor workspace${finding.loadedIn.length === 1 ? "" : "s"}`);
  return out.join(", ");
}

function table(rows: string[][]): string[] {
  const widths = rows.reduce<number[]>(
    (acc, row) => row.map((cell, index) => Math.max(acc[index] ?? 0, cell.length)),
    [],
  );
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

function describe(server?: Server): string {
  if (!server) return "";
  if (server.transport === "stdio") return `${server.command} ${(server.args ?? []).join(" ")}`.trim();
  return server.url ?? "";
}
