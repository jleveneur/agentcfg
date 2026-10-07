import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const AGENTS = ["cursor", "claude", "codex"];

export function resolveTargets(options = {}) {
  const home = options.home ?? homedir();
  return projectTargets(home, { claudeFile: join(home, ".claude", ".claude.json") });
}

export function projectTargets(projectDir, options = {}) {
  return {
    cursor: join(projectDir, ".cursor", "mcp.json"),
    claude: options.claudeFile ?? join(projectDir, ".mcp.json"),
    codex: join(projectDir, ".codex", "config.toml"),
  };
}

export async function discoverProjects(directory) {
  if (!directory) return [];
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(directory, entry.name))
    .sort();
}
