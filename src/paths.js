import { homedir } from "node:os";
import { join } from "node:path";

export const AGENTS = ["cursor", "claude", "codex"];

export function resolveTargets(options = {}) {
  const home = options.home ?? homedir();
  return {
    cursor: join(home, ".cursor", "mcp.json"),
    claude: join(home, ".claude", ".claude.json"),
    codex: join(home, ".codex", "config.toml"),
  };
}
