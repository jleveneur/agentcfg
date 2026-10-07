# agentcfg

One MCP config for Cursor, Claude Code, Codex, VS Code, and Gemini CLI, plus a scan that finds every MCP server on the machine.

```bash
npx @jleveneur/agentcfg scan
```

Each agent keeps MCP servers in its own places, with its own format and its own way to reference a secret:

| Agent       | User file                                   | Project file            | Variables                          |
| ----------- | ------------------------------------------- | ----------------------- | ---------------------------------- |
| Cursor      | `~/.cursor/mcp.json`                        | `.cursor/mcp.json`      | `${env:NAME}`                      |
| Claude Code | `~/.claude.json` → `mcpServers`             | `.mcp.json`             | `${NAME}`                          |
| Codex       | `~/.codex/config.toml`                      | `.codex/config.toml`    | `env_vars`, `bearer_token_env_var` |
| VS Code     | `<user dir>/Code/User/mcp.json` → `servers` | `.vscode/mcp.json`      | `${env:NAME}`                      |
| Gemini CLI  | `~/.gemini/settings.json`                   | `.gemini/settings.json` | `${NAME}`                          |

Claude Code reads `$CLAUDE_CONFIG_DIR/.claude.json` instead when that variable is set, and Codex reads `$CODEX_HOME/config.toml`. agentcfg follows both. Plugins add more servers on top, and Cursor also loads Claude Code's plugins.

agentcfg keeps one manifest and writes each agent's files from it.

## Install

```bash
npm install --global @jleveneur/agentcfg
```

Node.js 22.13 or newer. Or run it without installing: `npx @jleveneur/agentcfg <command>`.

## See what you have

```bash
agentcfg scan --projects ~/code
```

`scan` only reads. It lists every server, grouped by what it points to, so the same server spelled three ways shows up once:

```
https://mcp.linear.app/mcp  (linear)
  cursor  project  web     loaded in 1 Cursor workspace        ~/code/web/.cursor/mcp.json
  claude  project  web                                         ~/code/web/.mcp.json
  cursor  plugin   linear  installed for every project        ~/.cursor/plugins/cache/cursor-public/linear/…/plugin.json
```

It covers user and project files for every agent above plus Claude Desktop, Windsurf, and Devin Desktop; Claude Code's private per-project servers; the servers in Cursor, Claude Code, and Codex plugins, with where each plugin is turned on; and the servers Cursor loaded that no file defines any more. Projects come from `--projects DIR`, the current directory, and the projects Claude Code and Codex already know. Secrets are masked. `--json` prints the full report.

## Keep two manifests

Like git with `~/.gitconfig` and `.git/config`, agentcfg has a global manifest and one per project. Both have the same shape.

| Manifest | Holds                     | Lives in                                                   |
| -------- | ------------------------- | ---------------------------------------------------------- |
| Global   | Servers for every project | `~/.config/agentcfg/agentcfg.json` (or `$AGENTCFG_CONFIG`) |
| Project  | The project's servers     | `agentcfg.json` at the project root, committed             |

Commands work on the project manifest, found from the current directory up. Pass `--global` for the global one.

```bash
agentcfg add linear https://mcp.linear.app/mcp --global
agentcfg sync --global            # writes the user files

cd ~/code/web
agentcfg add reui https://mcp.reui.io
agentcfg add shadcn -- pnpm dlx shadcn@latest mcp
agentcfg sync                     # writes the project files
agentcfg status                   # what each agent made of them

agentcfg remove reui
agentcfg sync --prune
```

`add` takes a URL for a remote server, or a command after `--`. `--header 'KEY: VALUE'` and `--env 'KEY=VALUE'` can repeat, and `--agent cursor,claude` limits a server to some agents. The manifest is plain JSON you can also edit by hand, with a JSON Schema for completion:

```json
{
  "$schema": "https://unpkg.com/@jleveneur/agentcfg/agentcfg.schema.json",
  "version": 1,
  "agents": ["cursor", "claude", "codex", "vscode"],
  "servers": {
    "reui": { "transport": "http", "url": "https://mcp.reui.io" },
    "shadcn": { "transport": "stdio", "command": "pnpm", "args": ["dlx", "shadcn@latest", "mcp"] }
  }
}
```

`agents` lists the agent files the manifest writes. It defaults to `cursor`, `claude`, and `codex`; `agentcfg init --agent cursor,claude,codex,vscode,gemini` starts a manifest with more.

Commit both `agentcfg.json` and the files `sync` generates: anyone without agentcfg still gets the servers.

`import` builds a manifest from existing agent files: `agentcfg import --global` for your user configs, `agentcfg import` inside a project. Servers with literal secrets are skipped, and servers written by the Codex or ChatGPT app are left out.

### Secrets

Write secrets as `${NAME}`, in single quotes on the command line so the shell leaves them alone. `add` refuses literal secrets. `sync` writes each agent's own syntax:

| Manifest                                    | Cursor, VS Code       | Claude Code, Gemini | Codex                                  |
| ------------------------------------------- | --------------------- | ------------------- | -------------------------------------- |
| header `"Authorization": "Bearer ${TOKEN}"` | `Bearer ${env:TOKEN}` | unchanged           | `bearer_token_env_var = "TOKEN"`       |
| header `"X-Key": "${KEY}"`                  | `${env:KEY}`          | unchanged           | `env_http_headers = { X-Key = "KEY" }` |
| env `"TOKEN": "${TOKEN}"`                   | `${env:TOKEN}`        | unchanged           | `env_vars = ["TOKEN"]`                 |

## Check what the agents see

```bash
agentcfg status
```

`status` asks the `cursor-agent`, `claude`, and `codex` CLIs about their servers and lines the answers up with your manifests:

```
server         from     cursor          claude          codex
figma          global   needs login     ready           needs login
next-devtools  project  needs approval  needs approval  not trusted

To do:
  cursor: log in to figma in Cursor › Settings › MCP, or run cursor-agent mcp login NAME
  codex: trust this project in Codex so it loads next-devtools
```

It exits with 1 when a server is missing or failing.

## Safety

`sync` changes only the MCP entries of each file. It reads, changes, and writes each file in one step, and starts over if another app wrote the file in between, as Claude Code does with `~/.claude.json`. Servers that exist only in an agent stay there unless you pass `--prune`, and servers written by the Codex or ChatGPT app are never pruned. Before any file changes, agentcfg copies it to `~/.local/state/agentcfg/backups/<time>/`. Run `sync --dry-run --prune` first to see what would be removed.

Plugins and claude.ai connectors are not written by `sync`; `scan` and `status` report them.

## Development

The source is TypeScript that Node runs directly, so tests need no build step. Use pnpm.

```bash
pnpm install
pnpm check          # format, lint, typecheck, unit tests
pnpm test:live      # needs the claude, codex, and cursor-agent CLIs
node src/bin.ts scan
```

Releases go out from GitHub Actions: `npm version minor`, then `git push --follow-tags`. The tag triggers the release workflow, which publishes to npm with trusted publishing and creates the GitHub release.
