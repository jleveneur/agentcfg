import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { fileExists, isMissing } from "./files.ts"

export interface Context {
  home: string
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
}

// With --home, everything resolves under that directory with default
// locations, so a test or a dry run never reaches the real config through
// CLAUDE_CONFIG_DIR or CODEX_HOME.
export function createContext(options: { home?: string | null } = {}): Context {
  if (options.home) return { home: options.home, env: {}, platform: process.platform }
  return { home: homedir(), env: process.env, platform: process.platform }
}

export function locations(ctx: Context) {
  const { home, env } = ctx
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude")
  const codexHome = env.CODEX_HOME || join(home, ".codex")
  const cursorDir = join(home, ".cursor")
  return {
    cursorDir,
    cursorMcp: join(cursorDir, "mcp.json"),
    cursorPlugins: join(cursorDir, "plugins", "cache"),
    cursorProjects: join(cursorDir, "projects"),
    cursorState: join(appConfigDir(ctx, "Cursor"), "User", "globalStorage", "state.vscdb"),
    claudeDir,
    // Claude Code keeps user and local scoped servers in ~/.claude.json, or
    // in $CLAUDE_CONFIG_DIR/.claude.json when that variable is set.
    claudeJson: env.CLAUDE_CONFIG_DIR
      ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
      : join(home, ".claude.json"),
    claudeSettings: join(claudeDir, "settings.json"),
    claudePlugins: join(claudeDir, "plugins", "installed_plugins.json"),
    codexHome,
    codexConfig: join(codexHome, "config.toml"),
    codexPlugins: join(codexHome, "plugins", "cache"),
    claudeDesktop: join(appConfigDir(ctx, "Claude"), "claude_desktop_config.json"),
    vscodeUser: join(appConfigDir(ctx, "Code"), "User", "mcp.json"),
    // Windsurf became Devin Desktop and moved its file. scan reads both.
    windsurf: join(home, ".codeium", "windsurf", "mcp_config.json"),
    devin: join(env.XDG_CONFIG_HOME || join(home, ".config"), "devin", "mcp_config.json"),
    gemini: join(home, ".gemini", "settings.json"),
    globalManifest:
      env.AGENTCFG_CONFIG ||
      join(env.XDG_CONFIG_HOME || join(home, ".config"), "agentcfg", MANIFEST_NAME),
    stateDir:
      env.AGENTCFG_STATE_DIR ||
      (env.XDG_STATE_HOME
        ? join(env.XDG_STATE_HOME, "agentcfg")
        : join(home, ".local", "state", "agentcfg"))
  }
}

export const MANIFEST_NAME = "agentcfg.json"

// The project manifest is the nearest agentcfg.json in the directory or its
// parents, like git finds .git. The home directory and the global manifest
// are never taken for a project.
export async function findProjectManifest(start: string, ctx: Context): Promise<string | null> {
  const global = resolve(locations(ctx).globalManifest)
  const found = await findUp(start, ctx, (dir) => join(dir, MANIFEST_NAME), global)
  return found?.file ?? null
}

// The nearest file that fileFor(dir) names, from start up to, not including,
// the home directory: like git finding .git.
export async function findUp(
  start: string,
  ctx: Context,
  fileFor: (dir: string) => string,
  skip?: string
): Promise<{ file: string; root: string } | null> {
  const home = resolve(ctx.home)
  let dir = resolve(start)
  while (dir !== home) {
    const file = fileFor(dir)
    // oxlint-disable-next-line no-await-in-loop
    if (file !== skip && (await fileExists(file))) return { file, root: dir }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

export type Locations = ReturnType<typeof locations>

function appConfigDir(ctx: Context, name: string): string {
  if (ctx.platform === "darwin") return join(ctx.home, "Library", "Application Support", name)
  if (ctx.platform === "win32")
    return join(ctx.env.APPDATA || join(ctx.home, "AppData", "Roaming"), name)
  return join(ctx.env.XDG_CONFIG_HOME || join(ctx.home, ".config"), name)
}

export async function discoverProjects(directory: string | null | undefined): Promise<string[]> {
  if (!directory) return []
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(directory, entry.name))
      .toSorted()
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

// Either separator, so Windows paths shorten too.
export function tildify(path: string, home: string): string {
  if (path === home) return "~"
  return path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)
    ? `~${path.slice(home.length)}`
    : path
}
