# agentcfg

One MCP manifest for Cursor, Claude Code, and Codex.

Each agent stores MCP servers in its own file:

| Agent | File |
| --- | --- |
| Cursor | `~/.cursor/mcp.json` |
| Claude Code | `~/.claude/.claude.json` |
| Codex | `~/.codex/config.toml` |

`agentcfg` keeps a single `agentcfg.json` and writes those files from it.

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
node bin/agentcfg.js import --home "$HOME"
node bin/agentcfg.js diff
node bin/agentcfg.js sync
```

`import` reads the three configs and writes `agentcfg.json`. Servers that disagree across agents are left out until you pass `--prefer cursor`, `--prefer claude`, or `--prefer codex`.

`sync` adds or updates the servers from the manifest. Servers that already exist only inside an agent stay there. `--prune` removes those extras. Servers shipped by the Codex or ChatGPT app are kept either way.

Literal env values and headers are not copied into the manifest. Declare them as `${ENV_NAME}` yourself.

Marketplace plugins (Figma, Linear, and the Claude.ai connectors) are not part of these files, so they stay outside the manifest.

## Requirements

Node.js 20 or newer. The live check uses the `claude`, `codex`, and `cursor-agent` binaries when they are on `PATH`.

```bash
npm test
```
