import assert from "node:assert/strict"
import { mkdir, readFile, mkdtemp, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import { parseInstalls } from "../src/cursor-state.ts"
import { formatJson } from "../src/files.ts"
import { createContext, locations, tildify } from "../src/paths.ts"
import { cursorSlug } from "../src/scan.ts"
import { identity, redact } from "../src/servers.ts"
import { AGENTS } from "../src/types.ts"
import { put, run } from "./helpers.ts"

void test("identity folds runners, versions, and tracking params together", () => {
  assert.equal(
    identity({ transport: "stdio", command: "npx", args: ["-y", "shadcn@latest", "mcp"] }),
    "pkg:shadcn mcp"
  )
  assert.equal(
    identity({ transport: "stdio", command: "pnpm", args: ["dlx", "shadcn@latest", "mcp"] }),
    "pkg:shadcn mcp"
  )
  assert.equal(
    identity({ transport: "stdio", command: "npx", args: ["-y", "@scope/tool@1.2.3"] }),
    "pkg:@scope/tool"
  )
  assert.equal(
    identity({ transport: "http", url: "https://MCP.Sentry.dev/mcp/?utm_source=plugin" }),
    "https://mcp.sentry.dev/mcp"
  )
})

void test("formatJson keeps short scalar arrays on one line", () => {
  const long = Array.from({ length: 12 }, (_, index) => `argument-${index}`)
  const text = formatJson({
    a: { args: ["dlx", 'say "hi"'], env: { X: "1" } },
    b: long,
    c: [{ d: 1 }]
  })
  assert.match(text, /"args": \["dlx", "say \\"hi\\""\],/)
  assert.match(text, /"b": \[\n {4}"argument-0",/)
  assert.match(text, /"c": \[\n {4}\{\n/)
  assert.deepEqual(JSON.parse(text), {
    a: { args: ["dlx", 'say "hi"'], env: { X: "1" } },
    b: long,
    c: [{ d: 1 }]
  })
})

void test("redact masks literal secrets and keeps variable references", () => {
  const server = redact({
    transport: "stdio",
    command: "npx",
    args: [
      "server",
      "--api-key",
      "abc123",
      "--token=xyz",
      "--port",
      "3000",
      "ghp_abcdefghijklmnop"
    ],
    env: { API_TOKEN: "sk-live-secret", HOME_DIR: "${HOME}" }
  })
  assert.deepEqual(server.args, [
    "server",
    "--api-key",
    "<redacted>",
    "--token=<redacted>",
    "--port",
    "3000",
    "<redacted>"
  ])
  assert.deepEqual(server.env, { API_TOKEN: "<redacted>", HOME_DIR: "${HOME}" })
  assert.equal(
    redact({ transport: "http", url: "https://example.com/mcp?api_key=abc&team=1" }).url,
    "https://example.com/mcp?api_key=<redacted>&team=1"
  )
})

void test("scan finds files, private project servers, plugins, and what Cursor loaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcfg-scan-"))
  const home = join(root, "home")
  const projects = join(root, "code")
  const web = join(projects, "web")

  await put(join(home, ".cursor", "mcp.json"), {
    mcpServers: {
      github: {
        url: "https://api.githubcopilot.com/mcp",
        headers: { Authorization: "Bearer ghp_secretvalue123" }
      }
    }
  })
  await put(join(home, ".claude.json"), {
    mcpServers: { shadcn: { command: "npx", args: ["-y", "shadcn@latest", "mcp"] } },
    projects: {
      [web]: { mcpServers: { notes: { type: "http", url: "https://notes.example/mcp" } } }
    }
  })
  await put(join(web, ".cursor", "mcp.json"), {
    mcpServers: { shadcn: { command: "pnpm", args: ["dlx", "shadcn@latest", "mcp"] } }
  })
  await put(join(web, ".mcp.json"), {
    mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } }
  })

  // Claude Code plugin, enabled in settings.
  const claudePlugin = join(home, ".claude", "plugins", "cache", "official", "figma", "1.0.0")
  await put(join(home, ".claude", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: { "figma@official": [{ scope: "user", installPath: claudePlugin, version: "1.0.0" }] }
  })
  await put(join(home, ".claude", "settings.json"), { enabledPlugins: { "figma@official": true } })
  await put(join(claudePlugin, ".mcp.json"), {
    mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } }
  })

  // Codex plugin, turned off in config.toml.
  await put(join(home, ".codex", "config.toml"), '[plugins."notion@curated"]\nenabled = false\n')
  await put(join(home, ".codex", "plugins", "cache", "curated", "notion", "0.2.0", ".mcp.json"), {
    mcpServers: { notion: { url: "https://mcp.notion.com/mcp" } }
  })

  // Cursor plugin cached at two commits: the newer one declares its server inline.
  const cursorCache = join(home, ".cursor", "plugins", "cache", "cursor-public")
  const oldCommit = join(cursorCache, "407", "aaa")
  const newCommit = join(cursorCache, "linear", "bbb")
  await put(join(oldCommit, ".cursor-plugin", "plugin.json"), { name: "linear" })
  await put(join(oldCommit, "mcp.json"), {
    mcpServers: { "linear-old": { url: "https://old.linear.app/mcp" } }
  })
  await put(join(newCommit, ".cursor-plugin", "plugin.json"), {
    name: "linear",
    mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } }
  })
  await utimes(oldCommit, new Date("2026-01-01"), new Date("2026-01-01"))

  // What Cursor loaded in the web workspace, including a server that no
  // file defines any more.
  const loaded = join(home, ".cursor", "projects", cursorSlug(web), "mcps")
  for (const [id, name] of [
    ["plugin-linear-linear", "linear"],
    ["project-0-web-shadcn", "shadcn"],
    ["user-reui", "reui"],
    ["cursor-ide-browser", "browser"]
  ]) {
    await put(join(loaded, id ?? "", "SERVER_METADATA.json"), {
      serverIdentifier: id,
      serverName: name
    })
  }

  const result = await run(["scan", "--home", home, "--projects", projects, "--json"])
  assert.equal(result.code, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /ghp_secretvalue123/)
  const report = JSON.parse(result.stdout)
  const find = (agent: string, scope: string, name: string) =>
    report.findings.find(
      (f: { agent: string; scope: string; name: string }) =>
        f.agent === agent && f.scope === scope && f.name === name
    )

  assert.equal(find("cursor", "user", "github").server.headers.Authorization, "<redacted>")
  assert.equal(find("claude", "local", "notes").project, web)
  assert.equal(find("claude", "plugin", "figma").enabled, true)
  // Cursor imports Claude Code plugins by default.
  assert.deepEqual(find("claude", "plugin", "figma").alsoLoadedBy, ["cursor"])
  assert.equal(find("codex", "plugin", "notion").enabled, false)
  assert.equal(find("cursor", "plugin", "linear-old"), undefined)
  assert.deepEqual(find("cursor", "plugin", "linear").loadedIn, [web])
  assert.deepEqual(find("cursor", "project", "shadcn").loadedIn, [web])

  const shadcn = report.groups.find(
    (group: { identity: string }) => group.identity === "pkg:shadcn mcp"
  )
  assert.equal(shadcn.findings.length, 2)
  const linear = report.groups.find(
    (group: { identity: string }) => group.identity === "https://mcp.linear.app/mcp"
  )
  assert.deepEqual(
    linear.findings
      .map((f: { agent: string; scope: string }) => `${f.agent}/${f.scope}`)
      .toSorted(),
    ["claude/project", "cursor/plugin"]
  )

  assert.deepEqual(
    report.loadedOnly.map((entry: { id: string }) => entry.id),
    ["user-reui"]
  )

  const text = await run(["scan", "--home", home, "--projects", projects])
  assert.match(text.stdout, /user-reui\s+not in ~\/\.cursor\/mcp\.json\s+1 workspace\s+last loaded/)
  assert.match(text.stdout, /pkg:shadcn mcp {2}\(shadcn\)/)
})

const url = (path: string) => pathToFileURL(path).href

void test("tildify shortens the home folder with either separator", () => {
  assert.equal(tildify("/home/me/.claude/skills", "/home/me"), "~/.claude/skills")
  assert.equal(
    tildify(String.raw`C:\Users\me\.claude`, String.raw`C:\Users\me`),
    String.raw`~\.claude`
  )
  assert.equal(tildify("/home/me", "/home/me"), "~")
  assert.equal(tildify("/home/meow", "/home/me"), "/home/meow")
})

void test("parseInstalls splits user installs from each workspace's", () => {
  const web = process.platform === "win32" ? "C:\\code\\web" : "/code/web"
  const api = process.platform === "win32" ? "C:\\code\\api" : "/code/api"
  const installs = parseInstalls([
    {
      key: "cursor.plugins.installedIds.no-team|no-workspace",
      value: JSON.stringify([
        { id: "407", sources: ["user"] },
        { id: "9", sources: ["project"] }
      ])
    },
    {
      key: `cursor.plugins.installedIds.no-team|${url(web)},${url(api)}`,
      value: JSON.stringify([{ id: "408", sources: ["project"] }])
    },
    { key: "cursor.plugins.installedIds.no-team|no-workspace-bad", value: "not json" }
  ])
  assert.deepEqual(installs.user, ["407"])
  assert.deepEqual(installs.workspaces[web], [{ id: "408", fromProject: true }])
  assert.deepEqual(installs.workspaces[api], [{ id: "408", fromProject: true }])
})

void test("scan reads Cursor's install record to tell installed plugins from cached ones", async (t) => {
  const sqlite = await import("node:sqlite").catch(() => null)
  if (!sqlite) {
    t.skip("node:sqlite is not available")
    return
  }
  const root = await mkdtemp(join(tmpdir(), "agentcfg-cursor-state-"))
  const home = join(root, "home")
  const web = join(root, "code", "web")
  const cache = join(home, ".cursor", "plugins", "cache", "cursor-public")
  await put(join(cache, "407", "aaa", ".cursor-plugin", "plugin.json"), { name: "sentry" })
  await put(join(cache, "407", "aaa", "mcp.json"), {
    mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } }
  })
  await put(join(cache, "vercel", "bbb", ".cursor-plugin", "plugin.json"), { name: "vercel" })
  await put(join(cache, "vercel", "bbb", "mcp.json"), {
    mcpServers: { vercel: { url: "https://mcp.vercel.com" } }
  })
  await put(join(cache, "stripe", "ccc", ".cursor-plugin", "plugin.json"), { name: "stripe" })
  await put(join(cache, "stripe", "ccc", "mcp.json"), {
    mcpServers: { stripe: { url: "https://mcp.stripe.com" } }
  })
  await put(join(web, ".cursor", "settings.json"), { plugins: { stripe: { enabled: true } } })
  await put(join(web, "agentcfg.json"), { version: 1, servers: {} })

  const file = locations(createContext({ home })).cursorState
  await mkdir(dirname(file), { recursive: true })
  const db = new sqlite.DatabaseSync(file)
  db.exec("create table ItemTable (key text unique on conflict replace, value blob)")
  db.prepare("insert into ItemTable (key, value) values (?, ?)").run(
    "cursor.plugins.installedIds.no-team|no-workspace",
    JSON.stringify([
      { id: "407", sources: ["user"] },
      { id: "999", sources: ["user"] }
    ])
  )
  db.close()

  const result = await run(["scan", "--home", home, "--projects", join(root, "code"), "--json"])
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout) as {
    findings: { agent: string; name: string; installedIn?: string[]; enabled: boolean }[]
    warnings: string[]
  }
  const plugin = (name: string) =>
    report.findings.find((f) => f.agent === "cursor" && f.name === name)
  assert.deepEqual(plugin("sentry")?.installedIn, ["everywhere"])
  assert.deepEqual(plugin("stripe")?.installedIn, [web])
  assert.deepEqual(plugin("vercel")?.installedIn, [])
  assert.equal(plugin("vercel")?.enabled, false)
  assert.match(
    report.warnings.join("\n"),
    /1 installed plugin is not in the local cache \(ids 999\)/
  )

  const text = await run(["scan", "--home", home, "--projects", join(root, "code")])
  assert.match(text.stdout, /cursor +plugin +vercel +cached, not installed/)
  assert.match(text.stdout, /cursor +plugin +sentry +installed for every project/)
})

void test("the JSON schema lists the same agents and fields as the code", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../agentcfg.schema.json", import.meta.url), "utf8")
  ) as {
    properties: Record<string, unknown>
    $defs: { agent: { enum: string[] } }
  }
  assert.deepEqual(schema.$defs.agent.enum, [...AGENTS])
  assert.deepEqual(Object.keys(schema.properties).toSorted(), [
    "$schema",
    "agents",
    "servers",
    "version"
  ])
})

void test("scan finds projects through Cursor and sets aside what it kept from removed servers", async (t) => {
  const sqlite = await import("node:sqlite").catch(() => null)
  if (!sqlite) {
    t.skip("node:sqlite is not available")
    return
  }
  const root = await mkdtemp(join(tmpdir(), "agentcfg-cursor-recent-"))
  const home = join(root, "home")
  const app = join(home, "code", "app")
  await put(join(app, ".cursor", "mcp.json"), {
    mcpServers: { docs: { url: "https://docs.example/mcp" } }
  })
  await put(join(home, ".cursor", "mcp.json"), { mcpServers: {} })

  const file = locations(createContext({ home })).cursorState
  await mkdir(dirname(file), { recursive: true })
  const db = new sqlite.DatabaseSync(file)
  db.exec("create table ItemTable (key text unique on conflict replace, value blob)")
  db.prepare("insert into ItemTable (key, value) values (?, ?)").run(
    "history.recentlyOpenedPathsList",
    JSON.stringify({ entries: [{ folderUri: url(app) }, { folderUri: url(join(root, "gone")) }] })
  )
  db.close()

  // Cursor loaded two servers in the app: one from a plugin since removed,
  // one an extension added. And one in a temporary folder another tool opened.
  const snapshot = join(home, ".cursor", "projects", cursorSlug(app), "mcps")
  await put(join(snapshot, "plugin-gone-gone", "SERVER_METADATA.json"), {
    serverIdentifier: "plugin-gone-gone",
    serverName: "gone"
  })
  await put(join(snapshot, "user-ext-extension-Tool", "SERVER_METADATA.json"), {
    serverIdentifier: "user-ext-extension-Tool",
    serverName: "Tool"
  })
  const temporary = join(home, ".cursor", "projects", "var-folders-xy-T-tool-123", "mcps")
  await put(join(temporary, "user-ext-extension-Tool", "SERVER_METADATA.json"), {
    serverIdentifier: "user-ext-extension-Tool",
    serverName: "Tool"
  })
  // A user server Cursor loaded before ~/.cursor/mcp.json last changed.
  const old = join(snapshot, "user-reui")
  await put(join(old, "SERVER_METADATA.json"), {
    serverIdentifier: "user-reui",
    serverName: "reui"
  })
  await utimes(old, new Date("2026-01-01"), new Date("2026-01-01"))

  const result = await run(["scan", "--home", home, "--json"])
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout) as {
    projects: string[]
    findings: { agent: string; scope: string; name: string; project?: string }[]
    loadedOnly: { id: string; stale: boolean; workspaces: string[] }[]
  }
  assert.deepEqual(report.projects, [app])
  assert.ok(
    report.findings.some((f) => f.agent === "cursor" && f.scope === "project" && f.name === "docs")
  )
  const entry = (id: string) => report.loadedOnly.find((item) => item.id === id)
  assert.deepEqual(entry("user-ext-extension-Tool"), {
    ...entry("user-ext-extension-Tool"),
    stale: false,
    workspaces: [app]
  })
  assert.equal(entry("plugin-gone-gone")?.stale, true)
  assert.equal(entry("user-reui")?.stale, true)

  const text = await run(["scan", "--home", home])
  assert.match(text.stdout, /user-ext-extension-Tool +added by an IDE extension +1 workspace/)
  assert.doesNotMatch(text.stdout, /plugin-gone-gone/)
  assert.match(text.stdout, /2 more entries in Cursor's workspace snapshots/)
  const all = await run(["scan", "--home", home, "--all"])
  assert.match(all.stdout, /plugin-gone-gone +from a removed or updated plugin/)
  assert.match(all.stdout, /user-reui +removed from ~\/\.cursor\/mcp\.json/)
})
