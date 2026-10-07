import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import test from "node:test"

import { parseClaude, parseCodex, parseCursor } from "../src/status.ts"
import { put, run } from "./helpers.ts"

const CLAUDE = `Checking MCP server health…

claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication
figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected
linear: https://mcp.linear.app/mcp (HTTP) - ! Needs authentication
shadcn: pnpm dlx shadcn@latest mcp - ⏸ Pending approval (run \`claude\` to approve)
broken: npx broken-mcp - ✗ Failed to connect
`

const CURSOR = `figma: requires_authentication
next-devtools: ready
shadcn: not loaded (needs approval)
`

const CODEX = JSON.stringify([
  {
    name: "figma",
    enabled: true,
    auth_status: "not_logged_in",
    transport: { type: "streamable_http" }
  },
  {
    name: "docs",
    enabled: true,
    auth_status: "bearer_token",
    transport: { type: "streamable_http" }
  },
  {
    name: "old",
    enabled: false,
    auth_status: "unsupported",
    transport: { type: "stdio", command: "x" }
  },
  {
    name: "node_repl",
    enabled: true,
    auth_status: "unsupported",
    transport: { type: "stdio", command: "/Applications/ChatGPT.app/Contents/Resources/node_repl" }
  }
])

void test("parsers read each CLI's status words", () => {
  const claude = parseClaude(CLAUDE)
  assert.deepEqual(claude.connectors, ["Gmail", "Notion"])
  assert.deepEqual(
    Object.fromEntries(Object.entries(claude.servers).map(([name, value]) => [name, value.state])),
    { figma: "ready", linear: "needs-login", shadcn: "needs-approval", broken: "failed" }
  )

  const cursor = parseCursor(CURSOR)
  assert.equal(cursor.servers.figma?.state, "needs-login")
  assert.equal(cursor.servers["next-devtools"]?.state, "ready")
  assert.equal(cursor.servers.shadcn?.state, "needs-approval")

  const codex = parseCodex(CODEX)
  assert.equal(codex.servers.figma?.state, "needs-login")
  assert.equal(codex.servers.docs?.state, "configured")
  assert.equal(codex.servers.old?.state, "disabled")
  assert.deepEqual(codex.managed, ["node_repl"])
})

// Shell scripts stand in for the CLIs, so this one needs a POSIX shell.
void test(
  "status joins what each CLI reports with the manifests",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agentcfg-status-"))
    const home = join(root, "home")
    const app = join(root, "web")
    const bin = join(root, "bin")
    await mkdir(bin)
    const fake = async (name: string, output: string) => {
      await writeFile(join(root, `${name}.out`), output)
      await writeFile(join(bin, name), `#!/bin/sh\ncat "${join(root, `${name}.out`)}"\n`)
      await chmod(join(bin, name), 0o755)
    }
    await fake("claude", CLAUDE)
    await fake("cursor-agent", CURSOR)
    await fake("codex", CODEX)
    await put(join(home, ".config", "agentcfg", "agentcfg.json"), {
      version: 1,
      servers: {
        figma: { transport: "http", url: "https://mcp.figma.com/mcp" },
        linear: { transport: "http", url: "https://mcp.linear.app/mcp", agents: ["claude"] }
      }
    })
    await put(join(app, "agentcfg.json"), {
      version: 1,
      servers: {
        shadcn: { transport: "stdio", command: "pnpm", args: ["dlx", "shadcn@latest", "mcp"] },
        "next-devtools": { transport: "stdio", command: "pnpm", args: ["dlx", "next-devtools-mcp"] }
      }
    })

    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }
    const result = await run(["status", "--home", home], { cwd: app, env })
    assert.equal(result.code, 1, result.stderr)
    assert.match(result.stdout, /Project web/)
    assert.match(result.stdout, /figma +global +needs login +ready +needs login/)
    assert.match(result.stdout, /linear +global +- +needs login +-/)
    assert.match(result.stdout, /shadcn +project +needs approval +needs approval +not trusted/)
    assert.match(result.stdout, /next-devtools +project +ready +missing +not trusted/)
    assert.match(result.stdout, /claude +broken +failed/)
    assert.doesNotMatch(result.stdout, /node_repl/)
    assert.match(result.stdout, /Claude Code also loads 2 claude\.ai connectors: Gmail, Notion/)
    assert.match(
      result.stdout,
      /codex: trust this project in Codex so it loads shadcn, next-devtools/
    )

    // Codex keys projects by their real path, the one process.cwd() reports.
    const real = await realpath(app)
    await put(
      join(home, ".codex", "config.toml"),
      `[projects."${real}"]\ntrust_level = "trusted"\n`
    )
    const trusted = await run(["status", "--home", home, "--json"], { cwd: app, env })
    const report = JSON.parse(trusted.stdout) as {
      codexTrusted: boolean
      rows: { name: string; cells: { codex?: { state: string } } }[]
    }
    assert.equal(report.codexTrusted, true)
    assert.equal(report.rows.find((row) => row.name === "shadcn")?.cells.codex?.state, "missing")
  }
)
