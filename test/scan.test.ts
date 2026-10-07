import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { cursorSlug } from "../src/scan.ts";
import { identity, redact } from "../src/servers.ts";
import { run } from "./helpers.ts";

async function put(file: string, content: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
}

test("identity folds runners, versions, and tracking params together", () => {
  assert.equal(identity({ transport: "stdio", command: "npx", args: ["-y", "shadcn@latest", "mcp"] }), "pkg:shadcn mcp");
  assert.equal(identity({ transport: "stdio", command: "pnpm", args: ["dlx", "shadcn@latest", "mcp"] }), "pkg:shadcn mcp");
  assert.equal(identity({ transport: "stdio", command: "npx", args: ["-y", "@scope/tool@1.2.3"] }), "pkg:@scope/tool");
  assert.equal(identity({ transport: "http", url: "https://MCP.Sentry.dev/mcp/?utm_source=plugin" }), "https://mcp.sentry.dev/mcp");
});

test("redact masks literal secrets and keeps variable references", () => {
  const server = redact({
    transport: "stdio",
    command: "npx",
    args: ["server", "--api-key", "abc123", "--token=xyz", "--port", "3000", "ghp_abcdefghijklmnop"],
    env: { API_TOKEN: "sk-live-secret", HOME_DIR: "${HOME}" },
  });
  assert.deepEqual(server.args, ["server", "--api-key", "<redacted>", "--token=<redacted>", "--port", "3000", "<redacted>"]);
  assert.deepEqual(server.env, { API_TOKEN: "<redacted>", HOME_DIR: "${HOME}" });
  assert.equal(
    redact({ transport: "http", url: "https://example.com/mcp?api_key=abc&team=1" }).url,
    "https://example.com/mcp?api_key=<redacted>&team=1",
  );
});

test("scan finds files, private project servers, plugins, and what Cursor loaded", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcfg-scan-"));
  const home = join(root, "home");
  const projects = join(root, "code");
  const web = join(projects, "web");

  await put(join(home, ".cursor", "mcp.json"), {
    mcpServers: { github: { url: "https://api.githubcopilot.com/mcp", headers: { Authorization: "Bearer ghp_secretvalue123" } } },
  });
  await put(join(home, ".claude.json"), {
    mcpServers: { shadcn: { command: "npx", args: ["-y", "shadcn@latest", "mcp"] } },
    projects: { [web]: { mcpServers: { notes: { type: "http", url: "https://notes.example/mcp" } } } },
  });
  await put(join(web, ".cursor", "mcp.json"), { mcpServers: { shadcn: { command: "pnpm", args: ["dlx", "shadcn@latest", "mcp"] } } });
  await put(join(web, ".mcp.json"), { mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } });

  // Claude Code plugin, enabled in settings.
  const claudePlugin = join(home, ".claude", "plugins", "cache", "official", "figma", "1.0.0");
  await put(join(home, ".claude", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: { "figma@official": [{ scope: "user", installPath: claudePlugin, version: "1.0.0" }] },
  });
  await put(join(home, ".claude", "settings.json"), { enabledPlugins: { "figma@official": true } });
  await put(join(claudePlugin, ".mcp.json"), { mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } } });

  // Codex plugin, turned off in config.toml.
  await put(join(home, ".codex", "config.toml"), '[plugins."notion@curated"]\nenabled = false\n');
  await put(join(home, ".codex", "plugins", "cache", "curated", "notion", "0.2.0", ".mcp.json"), {
    mcpServers: { notion: { url: "https://mcp.notion.com/mcp" } },
  });

  // Cursor plugin cached at two commits: the newer one declares its server inline.
  const cursorCache = join(home, ".cursor", "plugins", "cache", "cursor-public");
  const oldCommit = join(cursorCache, "407", "aaa");
  const newCommit = join(cursorCache, "linear", "bbb");
  await put(join(oldCommit, ".cursor-plugin", "plugin.json"), { name: "linear" });
  await put(join(oldCommit, "mcp.json"), { mcpServers: { "linear-old": { url: "https://old.linear.app/mcp" } } });
  await put(join(newCommit, ".cursor-plugin", "plugin.json"), {
    name: "linear",
    mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } },
  });
  await utimes(oldCommit, new Date("2026-01-01"), new Date("2026-01-01"));

  // What Cursor loaded in the web workspace, including a server that no
  // file defines any more.
  const loaded = join(home, ".cursor", "projects", cursorSlug(web), "mcps");
  for (const [id, name] of [
    ["plugin-linear-linear", "linear"],
    ["project-0-web-shadcn", "shadcn"],
    ["user-reui", "reui"],
    ["cursor-ide-browser", "browser"],
  ]) {
    await put(join(loaded, id!, "SERVER_METADATA.json"), { serverIdentifier: id, serverName: name });
  }

  const result = await run(["scan", "--home", home, "--projects", projects, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /ghp_secretvalue123/);
  const report = JSON.parse(result.stdout);
  const find = (agent: string, scope: string, name: string) =>
    report.findings.find((f: { agent: string; scope: string; name: string }) => f.agent === agent && f.scope === scope && f.name === name);

  assert.equal(find("cursor", "user", "github").server.headers.Authorization, "<redacted>");
  assert.equal(find("claude", "local", "notes").project, web);
  assert.equal(find("claude", "plugin", "figma").enabled, true);
  assert.equal(find("codex", "plugin", "notion").enabled, false);
  assert.equal(find("cursor", "plugin", "linear-old"), undefined);
  assert.deepEqual(find("cursor", "plugin", "linear").loadedIn, [web]);
  assert.deepEqual(find("cursor", "project", "shadcn").loadedIn, [web]);

  const shadcn = report.groups.find((group: { identity: string }) => group.identity === "pkg:shadcn mcp");
  assert.equal(shadcn.findings.length, 2);
  const linear = report.groups.find((group: { identity: string }) => group.identity === "https://mcp.linear.app/mcp");
  assert.deepEqual(linear.findings.map((f: { agent: string; scope: string }) => `${f.agent}/${f.scope}`).sort(), ["claude/project", "cursor/plugin"]);

  assert.deepEqual(report.loadedOnly.map((entry: { id: string }) => entry.id), ["user-reui"]);

  const text = await run(["scan", "--home", home, "--projects", projects]);
  assert.match(text.stdout, /user-reui\s+no longer in ~\/\.cursor\/mcp\.json\s+1 workspace/);
  assert.match(text.stdout, /pkg:shadcn mcp {2}\(shadcn\)/);
});
