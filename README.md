# agentcfg

One MCP manifest for Cursor, Claude Code, and Codex.

Each agent stores MCP servers in its own file:

| Scope | Cursor | Claude Code | Codex |
| --- | --- | --- | --- |
| Global | `~/.cursor/mcp.json` | `~/.claude/.claude.json` | `~/.codex/config.toml` |
| Project | `.cursor/mcp.json` | `.mcp.json` | `.codex/config.toml` |

`agentcfg` keeps one `agentcfg.json`. Global servers go in `servers`. Project servers go in `projects`, keyed by the project path.

```json
{
  "version": 1,
  "servers": {
    "docs": {
      "transport": "http",
      "url": "https://example.com/mcp",
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

## Commands

```bash
node bin/agentcfg.js import
node bin/agentcfg.js diff
node bin/agentcfg.js sync --prune
```

`import` reads the global configs and every project directory in `~/Developments`. Pass `--projects` to scan somewhere else, or `--no-projects` to stay global. A server that already exists globally, including `reui` at `https://mcp.reui.io/api/mcp`, is kept once as the global server `https://mcp.reui.io`.

`sync` writes each server back to the agents and scope it belongs to. Servers that already exist only inside an agent stay there. `--prune` removes those extras from the files the manifest covers. Servers shipped by the Codex or ChatGPT app are kept either way.

Literal env values and headers are not copied into the manifest. Declare them as `${ENV_NAME}` yourself.

Marketplace plugins (Figma, Linear, and the Claude.ai connectors) are not part of these files, so they stay outside the manifest.

## Requirements

Node.js 20 or newer. The live check uses the `claude`, `codex`, and `cursor-agent` binaries when they are on `PATH`.

```bash
npm test
```
