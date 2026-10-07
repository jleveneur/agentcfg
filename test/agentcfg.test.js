import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/agentcfg.js", import.meta.url));

async function run(args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [bin, ...args], options);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: `${error.stderr ?? ""}${error.message ?? ""}`,
    };
  }
}

test("sync writes each agent format and leaves unrelated config in place", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentcfg-"));
  const manifest = join(home, "agentcfg.json");
  await writeFile(
    manifest,
    JSON.stringify(
      {
        version: 1,
        servers: {
          docs: {
            transport: "http",
            url: "https://example.com/mcp",
            agents: ["cursor", "claude", "codex"],
          },
          local: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "some-mcp-server"],
            env: { API_TOKEN: "${API_TOKEN}" },
          },
        },
      },
      null,
      2,
    ),
  );
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".claude", ".claude.json"),
    `${JSON.stringify({ userID: "keep-me", mcpServers: {} }, null, 2)}\n`,
  );
  await writeFile(
    join(home, ".codex", "config.toml"),
    `model = "gpt-test"\n\n[mcp_servers.docs]\nurl = "https://old.example/mcp"\n\n[projects."/tmp/work"]\ntrust_level = "trusted"\n\n[mcp_servers.node_repl]\ncommand = "/Applications/ChatGPT.app/Contents/Resources/node_repl"\n`,
  );

  const synced = await run(["sync", "--home", home, "--manifest", manifest]);
  assert.equal(synced.code, 0, synced.stderr);

  const cursor = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cursor.mcpServers.docs.url, "https://example.com/mcp");
  assert.equal(cursor.mcpServers.local.command, "npx");
  assert.deepEqual(cursor.mcpServers.local.env, { API_TOKEN: "${API_TOKEN}" });

  const claude = JSON.parse(await readFile(join(home, ".claude", ".claude.json"), "utf8"));
  assert.equal(claude.userID, "keep-me");
  assert.equal(claude.mcpServers.docs.type, "http");
  assert.equal(claude.mcpServers.docs.url, "https://example.com/mcp");

  const codex = await readFile(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codex, /model = "gpt-test"/);
  assert.match(codex, /\[projects\."\/tmp\/work"\]/);
  assert.match(codex, /trust_level = "trusted"/);
  assert.match(codex, /\[mcp_servers\.node_repl\]/);
  assert.doesNotMatch(codex, /old\.example/);
  assert.match(codex, /\[mcp_servers\.docs\]\nurl = "https:\/\/example\.com\/mcp"/);
  assert.match(codex, /\[mcp_servers\.local\.env\]\nAPI_TOKEN = "\$\{API_TOKEN\}"/);

  const again = await run(["diff", "--home", home, "--manifest", manifest]);
  assert.equal(again.code, 0, again.stdout);
  assert.match(again.stdout, /node_repl {2}only in the agent \(managed, left untouched\)/);
});

test("import skips secrets and app-managed servers, and reports conflicts", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentcfg-import-"));
  await mkdir(join(home, ".cursor"), { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        docs: { url: "https://example.com/mcp", headers: {} },
        keyed: { command: "npx", args: ["server"], env: { API_TOKEN: "sk-live-secret" } },
      },
    }),
  );
  await writeFile(
    join(home, ".claude", ".claude.json"),
    JSON.stringify({
      mcpServers: { docs: { type: "http", url: "https://example.com/other" } },
    }),
  );
  await writeFile(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.docs]\nurl = "https://example.com/mcp"\n\n[mcp_servers.node_repl]\ncommand = "/Applications/ChatGPT.app/Contents/Resources/node_repl"\n`,
  );

  const manifest = join(home, "agentcfg.json");
  const imported = await run(["import", "--home", home, "--manifest", manifest, "--no-projects"]);
  assert.equal(imported.code, 2, imported.stderr);
  assert.match(imported.stderr, /keyed/);
  assert.match(imported.stderr, /node_repl/);
  assert.match(imported.stderr, /docs: conflicting definitions/);
  const written = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(written.servers.docs, undefined);
  assert.equal(written.servers.keyed, undefined);
  assert.equal(written.servers.node_repl, undefined);
  assert.equal(await readFile(manifest, "utf8").then((text) => text.includes("sk-live-secret")), false);

  const preferred = await run(["import", "--home", home, "--manifest", manifest, "--no-projects", "--prefer", "cursor"]);
  assert.equal(preferred.code, 0, preferred.stderr);
  const chosen = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(chosen.servers.docs.url, "https://example.com/mcp");
  assert.deepEqual(chosen.servers.docs.agents.sort(), ["claude", "codex", "cursor"]);
});

test("prune removes extra user servers and keeps managed codex servers", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentcfg-prune-"));
  const manifest = join(home, "agentcfg.json");
  await writeFile(
    manifest,
    JSON.stringify({ version: 1, servers: { docs: { transport: "http", url: "https://example.com/mcp" } } }),
  );
  await mkdir(join(home, ".cursor"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { old: { url: "https://old.example/mcp" } } }),
  );
  await writeFile(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.old]\nurl = "https://old.example/mcp"\n\n[mcp_servers.node_repl]\ncommand = "/Applications/ChatGPT.app/Contents/Resources/node_repl"\n`,
  );

  const synced = await run(["sync", "--prune", "--home", home, "--manifest", manifest]);
  assert.equal(synced.code, 0, synced.stderr);
  const cursor = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cursor.mcpServers.old, undefined);
  assert.equal(cursor.mcpServers.docs.url, "https://example.com/mcp");
  const codex = await readFile(join(home, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(codex, /mcp_servers\.old/);
  assert.match(codex, /mcp_servers\.node_repl/);
});

test("import keeps a global server global and project servers in their projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcfg-scope-"));
  const home = join(root, "home");
  const projects = join(root, "projects");
  const app = join(projects, "web");
  const api = join(projects, "api");
  await mkdir(join(home, ".cursor"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(app, ".cursor"), { recursive: true });
  await mkdir(join(api, ".cursor"), { recursive: true });
  await writeFile(
    join(home, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { docs: { url: "https://example.com/mcp" } } }),
  );
  await writeFile(join(home, ".codex", "config.toml"), `[mcp_servers.docs]\nurl = "https://example.com/mcp"\n`);
  await writeFile(
    join(app, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        docs: { url: "https://example.com/mcp" },
        "local-tools": { command: "npx", args: ["-y", "some-mcp-server"] },
      },
    }),
  );
  await writeFile(
    join(api, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        notes: { type: "http", url: "https://notes.example/mcp" },
      },
    }),
  );
  await writeFile(
    join(api, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        search: { command: "npx", args: ["-y", "search-mcp"] },
        notes: { url: "https://notes.example/mcp" },
      },
    }),
  );

  const manifest = join(root, "agentcfg.json");
  const imported = await run(["import", "--home", home, "--projects", projects, "--manifest", manifest]);
  assert.equal(imported.code, 0, imported.stderr);
  assert.match(imported.stderr, /web: docs matches the global server/);
  const written = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(written.servers.docs.url, "https://example.com/mcp");
  assert.equal(written.servers.docs.scope, "global");
  assert.deepEqual(written.servers.docs.agents.sort(), ["codex", "cursor"]);
  assert.equal(written.projects[app].docs, undefined);
  assert.equal(written.projects[app]["local-tools"].command, "npx");
  assert.equal(written.projects[api].search.command, "npx");
  assert.deepEqual(written.projects[api].notes.agents.sort(), ["claude", "cursor"]);

  const synced = await run(["sync", "--prune", "--home", home, "--manifest", manifest]);
  assert.equal(synced.code, 0, synced.stderr);
  const globalCursor = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"));
  assert.equal(globalCursor.mcpServers.docs.url, "https://example.com/mcp");
  assert.equal(globalCursor.mcpServers["local-tools"], undefined);
  const codex = await readFile(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codex, /url = "https:\/\/example\.com\/mcp"\n/);
  const appCursor = JSON.parse(await readFile(join(app, ".cursor", "mcp.json"), "utf8"));
  assert.equal(appCursor.mcpServers.docs, undefined);
  assert.equal(appCursor.mcpServers["local-tools"].command, "npx");
  const apiClaude = JSON.parse(await readFile(join(api, ".mcp.json"), "utf8"));
  assert.equal(apiClaude.mcpServers.notes.url, "https://notes.example/mcp");
  assert.equal(apiClaude.mcpServers.search, undefined);
});
