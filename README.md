# agentcfg

One MCP manifest for Cursor, Claude Code, and Codex, plus a scan that finds every MCP server on the machine.

Each agent keeps MCP servers in its own places, with its own format:

| Scope | Cursor | Claude Code | Codex |
| --- | --- | --- | --- |
| User | `~/.cursor/mcp.json` | `~/.claude.json` → `mcpServers` | `~/.codex/config.toml` |
| Project, shared | `.cursor/mcp.json` | `.mcp.json` | `.codex/config.toml` |
| Project, private | — | `~/.claude.json` → `projects[path].mcpServers` | — |
| Plugins | `~/.cursor/plugins/cache/…` | `~/.claude/plugins/…` | `~/.codex/plugins/cache/…` |

Claude Code reads `$CLAUDE_CONFIG_DIR/.claude.json` instead when that variable is set, and Codex reads `$CODEX_HOME/config.toml`. agentcfg follows both.

## See what you have

```bash
npx agentcfg scan --projects ~/code
```

`scan` only reads. It lists every server, grouped by what it points to, so the same server spelled three ways shows up once:

```
https://mcp.linear.app/mcp  (linear)
  cursor  project  web     loaded in 1 Cursor workspace    ~/code/web/.cursor/mcp.json
  claude  project  web                                     ~/code/web/.mcp.json
  cursor  plugin   linear  loaded in 26 Cursor workspaces  ~/.cursor/plugins/cache/cursor-public/linear/…/plugin.json
```

It covers:

- user and project files for Cursor, Claude Code, Codex, Claude Desktop, VS Code, Windsurf, and Gemini CLI
- Claude Code's private per-project servers
- servers shipped by Cursor, Claude Code, and Codex plugins, with whether each plugin is turned on
- which servers Cursor last loaded in each workspace, from `~/.cursor/projects/*/mcps`, and the ones it loaded that no file defines any more (IDE extensions, deleted entries)

Projects come from `--projects DIR`, the current directory, and the projects Claude Code and Codex already know. Env values, headers, credential-like query params, and arguments are masked. `--json` prints the full report.

## Keep one manifest

`agentcfg.json` holds the servers you manage. Global servers go in `servers`. Project servers go in `projects`, keyed by the project path.

```json
{
  "version": 1,
  "servers": {
    "docs": {
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "agents": ["cursor", "claude", "codex"]
    },
    "local-tools": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": { "API_TOKEN": "${API_TOKEN}" }
    }
  }
}
```

```bash
npx agentcfg import --projects ~/code
npx agentcfg diff
npx agentcfg sync --dry-run --prune
npx agentcfg sync --prune
```

`import` reads the global configs, and with `--projects DIR` the projects inside `DIR`. A project server that matches a global server is kept once, as the global server. Servers with literal secrets are skipped: write them as `${ENV_NAME}` yourself.

`sync` writes each server to the agents and scope it belongs to, and leaves the rest of each file alone. Servers that exist only in an agent stay there unless you pass `--prune`. Servers written by the Codex or ChatGPT app are never pruned. Before any file changes, agentcfg copies it to `~/.local/state/agentcfg/backups/<time>/`, and it prints what `--prune` removed. Run with `--dry-run` first to see what would change.

For Codex, a header written `${VAR}` becomes `env_http_headers`, and a literal one becomes `http_headers`.

Plugins and hosted connectors are not written by `sync`; `scan` reports them.

## Development

Node.js 22.18 or newer. The source is TypeScript and runs directly on Node, so tests need no build step.

```bash
npm install
npm test            # unit tests, plus the live test when claude, codex, and cursor-agent are on PATH
npm run typecheck
npm run build       # compiles to dist/ for publishing
node src/bin.ts scan
```
