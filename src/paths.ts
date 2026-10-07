import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent } from "./types.ts";

export interface Context {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
}

// With --home, everything resolves under that directory with default
// locations, so a test or a dry run never reaches the real config through
// CLAUDE_CONFIG_DIR or CODEX_HOME.
export function createContext(options: { home?: string | null } = {}): Context {
  if (options.home) return { home: options.home, env: {}, platform: process.platform };
  return { home: homedir(), env: process.env, platform: process.platform };
}

export function locations(ctx: Context) {
  const { home, env } = ctx;
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const cursorDir = join(home, ".cursor");
  return {
    cursorDir,
    cursorMcp: join(cursorDir, "mcp.json"),
    cursorPlugins: join(cursorDir, "plugins", "cache"),
    cursorProjects: join(cursorDir, "projects"),
    claudeDir,
    // Claude Code keeps user and local scoped servers in ~/.claude.json, or
    // in $CLAUDE_CONFIG_DIR/.claude.json when that variable is set.
    claudeJson: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json"),
    claudeSettings: join(claudeDir, "settings.json"),
    claudePlugins: join(claudeDir, "plugins", "installed_plugins.json"),
    codexHome,
    codexConfig: join(codexHome, "config.toml"),
    codexPlugins: join(codexHome, "plugins", "cache"),
    claudeDesktop: join(appConfigDir(ctx, "Claude"), "claude_desktop_config.json"),
    vscodeUser: join(appConfigDir(ctx, "Code"), "User", "mcp.json"),
    windsurf: join(home, ".codeium", "windsurf", "mcp_config.json"),
    gemini: join(home, ".gemini", "settings.json"),
    stateDir:
      env.AGENTCFG_STATE_DIR ||
      (env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "agentcfg") : join(home, ".local", "state", "agentcfg")),
  };
}

export type Locations = ReturnType<typeof locations>;
export type Targets = Partial<Record<Agent, string>>;

export function globalTargets(ctx: Context): Record<Agent, string> {
  const paths = locations(ctx);
  return { cursor: paths.cursorMcp, claude: paths.claudeJson, codex: paths.codexConfig };
}

export function projectTargets(projectDir: string): Record<Agent, string> {
  return {
    cursor: join(projectDir, ".cursor", "mcp.json"),
    claude: join(projectDir, ".mcp.json"),
    codex: join(projectDir, ".codex", "config.toml"),
  };
}

function appConfigDir(ctx: Context, name: string): string {
  if (ctx.platform === "darwin") return join(ctx.home, "Library", "Application Support", name);
  if (ctx.platform === "win32") return join(ctx.env.APPDATA || join(ctx.home, "AppData", "Roaming"), name);
  return join(ctx.env.XDG_CONFIG_HOME || join(ctx.home, ".config"), name);
}

export async function discoverProjects(directory: string | null | undefined): Promise<string[]> {
  if (!directory) return [];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function tildify(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
