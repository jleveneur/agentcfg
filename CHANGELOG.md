# Changelog

## 0.1.0

First release on npm, as `@jleveneur/agentcfg`.

- `scan` lists every MCP server on the machine: user and project files for Cursor, Claude Code, Codex, VS Code, Gemini CLI, Claude Desktop, Windsurf, and Devin Desktop; Claude Code's private per-project servers; plugin servers with where each plugin is on; and what Cursor last loaded.
- A global manifest and one per project, found from the current directory up. `init`, `add`, `remove`, `import`, `diff`, and `sync` work on either.
- `sync` writes Cursor, Claude Code, Codex, VS Code, and Gemini CLI, each in its own variable syntax, backs up every file first, and retries when another app writes the file at the same time.
- `status` asks the cursor-agent, claude, and codex CLIs which servers are ready, need a login, wait for approval, or are ignored because Codex does not trust the project.
- A JSON Schema for `agentcfg.json`.
