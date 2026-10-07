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

## Keep two manifests

Like git with `~/.gitconfig` and `.git/config`, agentcfg has a global manifest and one per project.

| Manifest | Holds | Lives in |
| --- | --- | --- |
| Global | Servers for every project, and presets | `~/.config/agentcfg/agentcfg.json` (or `$AGENTCFG_CONFIG`) |
| Project | The project's servers | `agentcfg.json` at the project root, committed |

Commands work on the project manifest, found from the current directory up. Pass `--global` for the global one.

```json
{
  "version": 1,
  "servers": {
    "linear": { "transport": "http", "url": "https://mcp.linear.app/mcp" },
    "docs": {
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  },
  "presets": {
    "nextjs": {
      "next-devtools": { "transport": "stdio", "command": "pnpm", "args": ["dlx", "next-devtools-mcp@latest"] },
      "shadcn": { "transport": "stdio", "command": "pnpm", "args": ["dlx", "shadcn@latest", "mcp"] }
    }
  }
}
```

```bash
agentcfg sync --global            # ~/.cursor/mcp.json, ~/.claude.json, ~/.codex/config.toml
cd ~/code/web
agentcfg add nextjs               # copies the preset into ./agentcfg.json
agentcfg sync                     # .cursor/mcp.json, .mcp.json, .codex/config.toml
agentcfg diff                     # exit code 1 when an agent file drifted
```

A server goes to every agent unless it lists `"agents": ["cursor", "claude"]`.

`add` copies the preset's servers into the project manifest, so the project file stands on its own and teammates do not need your presets. Commit both `agentcfg.json` and the files `sync` generates: anyone without agentcfg still gets the servers.

`import` builds a manifest from existing agent files: `agentcfg import --global` for your home configs, `agentcfg import` inside a project. Servers with literal secrets are skipped, and servers written by the Codex or ChatGPT app are left out.

### Variables and secrets

Write secrets as `${NAME}` in the manifest. agentcfg translates them for each agent:

| Manifest | Cursor | Claude Code | Codex |
| --- | --- | --- | --- |
| `"Authorization": "Bearer ${TOKEN}"` | `Bearer ${env:TOKEN}` | unchanged | `bearer_token_env_var = "TOKEN"` |
| header `"X-Key": "${KEY}"` | `${env:KEY}` | unchanged | `env_http_headers = { X-Key = "KEY" }` |
| env `"TOKEN": "${TOKEN}"` | `${env:TOKEN}` | unchanged | `env_vars = ["TOKEN"]` |

### Safety

`sync` changes only the MCP entries of each file. Servers that exist only in an agent stay there unless you pass `--prune`, and servers written by the Codex or ChatGPT app are never pruned. Before any file changes, agentcfg copies it to `~/.local/state/agentcfg/backups/<time>/`. Run `sync --dry-run --prune` first to see what would be removed.

Plugins and claude.ai connectors are not written by `sync`; `scan` reports plugins.

## Development

Node.js 22.18 or newer. The source is TypeScript and runs directly on Node, so tests need no build step.

```bash
npm install
npm test            # unit tests, plus the live test when claude, codex, and cursor-agent are on PATH
npm run typecheck
npm run build       # compiles to dist/ for publishing
node src/bin.ts scan
```
