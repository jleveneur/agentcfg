import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { bin } from "./helpers.ts"

const execFileAsync = promisify(execFile)

async function commandExists(command: string) {
  try {
    await execFileAsync("which", [command])
    return true
  } catch {
    return false
  }
}

const hasClaude = await commandExists("claude")
const hasCodex = await commandExists("codex")
const hasCursor = await commandExists("cursor-agent")

test(
  "local CLIs read a config written by agentcfg",
  { skip: !hasClaude || !hasCodex || !hasCursor, timeout: 60_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "agentcfg-live-"))
    const manifest = join(home, ".config", "agentcfg", "agentcfg.json")
    await mkdir(join(home, ".config", "agentcfg"), { recursive: true })
    await writeFile(
      manifest,
      `${JSON.stringify(
        {
          version: 1,
          servers: {
            demo: { transport: "http", url: "https://example.com/mcp" }
          }
        },
        null,
        2
      )}\n`
    )

    await execFileAsync(process.execPath, [bin, "sync", "--global", "--home", home])

    // CLAUDE_CONFIG_DIR=<home> makes Claude Code read <home>/.claude.json,
    // the file sync writes for a --home of <home>.
    const claude = await execFileAsync("claude", ["mcp", "list"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: home }
    })
    assert.match(claude.stdout, /demo:/)

    const codex = await execFileAsync("codex", ["mcp", "list"], {
      env: { ...process.env, CODEX_HOME: join(home, ".codex") }
    })
    assert.match(codex.stdout, /demo/)
    assert.match(codex.stdout, /https:\/\/example\.com\/mcp/)

    const cursor = await execFileAsync("cursor-agent", ["mcp", "list"], { cwd: home })
    assert.match(cursor.stdout, /demo:/)

    const cursorFile = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"))
    assert.equal(cursorFile.mcpServers.demo.url, "https://example.com/mcp")
  }
)
