# Changelog

## 0.3.0

- `scan` lists skills: every skill folder each agent reads, user and project, the skills of active plugins, and the ones agents ship with. It flags a skill an agent loads twice from different folders, and the skills an agent cannot see, with what fixes it.
- `agentcfg link` lets Claude Code see the skills in `.agents/skills`, the folder Codex, Cursor, Gemini CLI, and VS Code share: one `.claude/skills` link in a project, or one link per skill with `--global`, leaving Claude Code's own skills and its synced folder alone.

## 0.2.0

- `scan` finds projects through Cursor's list of opened folders, so it no longer needs `--projects` to see projects that only Cursor knows. Temporary folders that other tools open Cursor in are left out.
- `scan` tells live servers that Cursor loaded but no file defines, such as ones an IDE extension adds, from leftovers of servers removed since a workspace was last opened. Leftovers are counted apart and listed with `--all`, each with the date Cursor last loaded it.

## 0.1.2

- Releases are published from GitHub Actions with npm trusted publishing and a provenance attestation.

## 0.1.0

First release on npm, as `@jleveneur/agentcfg`.

- `scan` lists every MCP server on the machine: user and project files for Cursor, Claude Code, Codex, VS Code, Gemini CLI, Claude Desktop, Windsurf, and Devin Desktop; Claude Code's private per-project servers; plugin servers with where each plugin is on; and what Cursor last loaded.
- A global manifest and one per project, found from the current directory up. `init`, `add`, `remove`, `import`, `diff`, and `sync` work on either.
- `sync` writes Cursor, Claude Code, Codex, VS Code, and Gemini CLI, each in its own variable syntax, backs up every file first, and retries when another app writes the file at the same time.
- `status` asks the cursor-agent, claude, and codex CLIs which servers are ready, need a login, wait for approval, or are ignored because Codex does not trust the project.
- A JSON Schema for `agentcfg.json`.
