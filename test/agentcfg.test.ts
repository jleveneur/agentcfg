import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { run } from "./helpers.ts";

async function put(file: string, content: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const globalManifest = (home: string) => join(home, ".config", "agentcfg", "agentcfg.json");

test("sync --global writes each agent's format and leaves the rest of each file alone", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentcfg-"));
  await put(globalManifest(home), {
    version: 1,
    servers: {
      docs: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
      local: { transport: "stdio", command: "npx", args: ["-y", "some-mcp-server"], env: { API_TOKEN: "${API_TOKEN}" } },
    },
  });
  await put(join(home, ".claude.json"), { userID: "keep-me", mcpServers: {} });
  await put(
    join(home, ".codex", "config.toml"),
    `model = "gpt-test"\n\n[mcp_servers.docs]\nurl = "https://old.example/mcp"\n\n[projects."/tmp/work"]\ntrust_level = "trusted"\n\n[mcp_servers.node_repl]\ncommand = "/Applications/ChatGPT.app/Contents/Resources/node_repl"\n`,
  );

  const synced = await run(["sync", "--global", "--home", home]);
  assert.equal(synced.code, 0, synced.stderr);

  // Cursor only expands ${env:NAME}.
  const cursor = await json(join(home, ".cursor", "mcp.json"));
  assert.deepEqual(cursor.mcpServers.docs, { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${env:DOCS_TOKEN}" } });
  assert.deepEqual(cursor.mcpServers.local.env, { API_TOKEN: "${env:API_TOKEN}" });

  const claude = await json(join(home, ".claude.json"));
  assert.equal(claude.userID, "keep-me");
  assert.deepEqual(claude.mcpServers.docs, { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } });

  const codex = await readFile(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codex, /model = "gpt-test"/);
  assert.match(codex, /\[projects\."\/tmp\/work"\]\ntrust_level = "trusted"/);
  assert.match(codex, /\[mcp_servers\.node_repl\]/);
  assert.doesNotMatch(codex, /old\.example/);
  assert.match(codex, /\[mcp_servers\.docs\]\nurl = "https:\/\/example\.com\/mcp"\nbearer_token_env_var = "DOCS_TOKEN"/);
  assert.match(codex, /\[mcp_servers\.local\]\ncommand = "npx"\nargs = \["-y", "some-mcp-server"\]\nenv_vars = \["API_TOKEN"\]/);
  assert.doesNotMatch(codex, /mcp_servers\.local\.env/);

  const again = await run(["diff", "--global", "--home", home]);
  assert.equal(again.code, 0, again.stdout);
  assert.match(again.stdout, /node_repl {2}only in the agent \(managed, left untouched\)/);
});

test("import --global skips secrets and app-managed servers, and reports conflicts", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentcfg-import-"));
  await put(join(home, ".cursor", "mcp.json"), {
    mcpServers: {
      docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${env:DOCS_TOKEN}" } },
      keyed: { command: "npx", args: ["server"], env: { API_TOKEN: "sk-live-secret" } },
    },
  });
  await put(join(home, ".claude.json"), { mcpServers: { docs: { type: "http", url: "https://example.com/other" } } });
  await put(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.docs]\nurl = "https://example.com/mcp"\nbearer_token_env_var = "DOCS_TOKEN"\n\n[mcp_servers.node_repl]\ncommand = "/Applications/ChatGPT.app/Contents/Resources/node_repl"\n`,
  );

  const imported = await run(["import", "--global", "--home", home]);
  assert.equal(imported.code, 2, imported.stderr);
  assert.match(imported.stderr, /keyed \(literal secret in env\.API_TOKEN\)/);
  assert.match(imported.stderr, /node_repl \(managed by the agent app\)/);
  assert.match(imported.stderr, /docs: conflicting definitions in cursor, claude, codex/);
  const written = await json(globalManifest(home));
  assert.deepEqual(written.servers, {});
  assert.doesNotMatch(await readFile(globalManifest(home), "utf8"), /sk-live-secret/);

  const preferred = await run(["import", "--global", "--home", home, "--prefer", "cursor"]);
  assert.equal(preferred.code, 0, preferred.stderr);
  const chosen = await json(globalManifest(home));
  // Cursor's ${env:NAME} and Codex's bearer_token_env_var both read back as ${NAME}.
  assert.deepEqual(chosen.servers.docs, {
    transport: "http",
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
  });

  const again = await run(["import", "--global", "--home", home, "--prefer", "cursor"]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already lists servers\. Pass --force/);
});

test("prune previews, backs up, and reports what it removes", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentcfg-prune-"));
  await put(globalManifest(home), { version: 1, servers: { docs: { transport: "http", url: "https://example.com/mcp" } } });
  await put(join(home, ".cursor", "mcp.json"), { mcpServers: { old: { url: "https://old.example/mcp" } } });
  await put(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.old]\nurl = "https://old.example/mcp"\n\n[mcp_servers.node_repl]\ncommand = "/Applications/ChatGPT.app/Contents/Resources/node_repl"\n`,
  );

  const preview = await run(["sync", "--global", "--prune", "--dry-run", "--home", home]);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /--prune would remove: cursor old, codex old/);
  assert.match(await readFile(join(home, ".cursor", "mcp.json"), "utf8"), /old\.example/);

  const synced = await run(["sync", "--global", "--prune", "--home", home]);
  assert.equal(synced.code, 0, synced.stderr);
  assert.match(synced.stdout, /Removed cursor old, codex old/);
  const backups = join(home, ".local", "state", "agentcfg", "backups");
  const [stamp] = await readdir(backups);
  assert.match(await readFile(join(backups, stamp!, home.slice(1), ".cursor", "mcp.json"), "utf8"), /old\.example/);
  const cursor = await json(join(home, ".cursor", "mcp.json"));
  assert.equal(cursor.mcpServers.old, undefined);
  assert.equal(cursor.mcpServers.docs.url, "https://example.com/mcp");
  const codex = await readFile(join(home, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(codex, /mcp_servers\.old/);
  assert.match(codex, /mcp_servers\.node_repl/);
});

test("add and remove edit the project manifest, and sync writes the project files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcfg-project-"));
  const home = join(root, "home");
  const app = join(root, "code", "web");
  await mkdir(join(app, "src", "pages"), { recursive: true });
  await put(globalManifest(home), { version: 1, servers: { linear: { transport: "http", url: "https://mcp.linear.app/mcp" } } });
  await put(join(app, ".mcp.json"), { mcpServers: { shadcn: { command: "npx", args: ["shadcn", "mcp"] } } });

  const missing = await run(["sync", "--home", home], { cwd: app });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No agentcfg\.json in .* or its parents/);

  const remote = await run(["add", "reui", "https://mcp.reui.io", "--header", "Authorization: Bearer ${REUI_TOKEN}", "--home", home], { cwd: app });
  assert.equal(remote.code, 0, remote.stderr);
  assert.match(remote.stdout, /Added reui in .*agentcfg\.json/);
  const local = await run(
    ["add", "shadcn", "--agent", "cursor,claude", "--home", home, "--", "pnpm", "dlx", "shadcn@latest", "mcp"],
    { cwd: app },
  );
  assert.equal(local.code, 0, local.stderr);
  assert.deepEqual((await json(join(app, "agentcfg.json"))).servers, {
    reui: { transport: "http", url: "https://mcp.reui.io", headers: { Authorization: "Bearer ${REUI_TOKEN}" } },
    shadcn: { transport: "stdio", command: "pnpm", args: ["dlx", "shadcn@latest", "mcp"], agents: ["cursor", "claude"] },
  });

  const secret = await run(["add", "keyed", "https://x.example/mcp", "--header", "X-Key: abc123", "--home", home], { cwd: app });
  assert.equal(secret.code, 1);
  assert.match(secret.stderr, /Literal secret in headers\.X-Key/);
  const again = await run(["add", "reui", "https://other.example/mcp", "--home", home], { cwd: app });
  assert.match(again.stderr, /reui is already in .* Pass --force/);

  // Found from a subdirectory, like git.
  const synced = await run(["sync", "--home", home], { cwd: join(app, "src", "pages") });
  assert.equal(synced.code, 0, synced.stderr);
  assert.deepEqual(Object.keys((await json(join(app, ".cursor", "mcp.json"))).mcpServers), ["reui", "shadcn"]);
  assert.deepEqual((await json(join(app, ".mcp.json"))).mcpServers.shadcn.args, ["dlx", "shadcn@latest", "mcp"]);
  const codex = await readFile(join(app, ".codex", "config.toml"), "utf8");
  assert.match(codex, /\[mcp_servers\.reui\]\nurl = "https:\/\/mcp\.reui\.io"\nbearer_token_env_var = "REUI_TOKEN"/);
  assert.doesNotMatch(codex, /shadcn/);
  assert.deepEqual(await readdir(home).then((entries) => entries.sort()), [".config", ".local"]);
  assert.equal((await run(["diff", "--home", home], { cwd: app })).code, 0);

  const removed = await run(["remove", "reui", "--home", home], { cwd: app });
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /sync --prune/);
  const pruned = await run(["sync", "--prune", "--home", home], { cwd: app });
  assert.match(pruned.stdout, /Removed cursor reui, claude reui, codex reui/);

  const global = await run(["add", "figma", "https://mcp.figma.com/mcp", "--global", "--home", home], { cwd: app });
  assert.equal(global.code, 0, global.stderr);
  assert.deepEqual(Object.keys((await json(globalManifest(home))).servers), ["figma", "linear"]);
});

test("import in a project creates its manifest from the project files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcfg-project-import-"));
  const home = join(root, "home");
  const app = join(root, "api");
  await put(join(app, ".cursor", "mcp.json"), {
    mcpServers: { notes: { url: "https://notes.example/mcp" }, search: { command: "npx", args: ["-y", "search-mcp"] } },
  });
  await put(join(app, ".mcp.json"), { mcpServers: { notes: { type: "http", url: "https://notes.example/mcp" } } });

  const imported = await run(["import", "--home", home], { cwd: app });
  assert.equal(imported.code, 0, imported.stderr);
  const manifest = await json(join(app, "agentcfg.json"));
  assert.deepEqual(manifest.servers.notes.agents.sort(), ["claude", "cursor"]);
  assert.deepEqual(manifest.servers.search.agents, ["cursor"]);
});

test("manifests in older formats are refused with a hint", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentcfg-old-"));
  await put(globalManifest(home), { version: 1, servers: {}, projects: { "/tmp/web": {} } });
  const projects = await run(["sync", "--global", "--home", home]);
  assert.equal(projects.code, 1);
  assert.match(projects.stderr, /Each project now keeps its own agentcfg\.json/);

  await put(globalManifest(home), { version: 1, servers: {}, presets: { nextjs: {} } });
  const presets = await run(["sync", "--global", "--home", home]);
  assert.equal(presets.code, 1);
  assert.match(presets.stderr, /has presets, which agentcfg no longer reads/);
});

test("codex config round-trips quoted names, literal strings, and env headers", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentcfg-toml-"));
  await put(
    join(home, ".codex", "config.toml"),
    [
      'model = "gpt-test"',
      'notes = """',
      "[not_a_section]",
      '"""',
      "",
      '[mcp_servers."docs.v2"]',
      'url = "https://docs.example/mcp"',
      'env_http_headers = { "X-Team" = "DOCS_TEAM" }',
      "",
      "[mcp_servers.local]",
      'command = "npx"',
      "args = [",
      '  "-y",',
      '  "local-mcp",',
      "]",
      'env_vars = ["LOCAL_TOKEN"]',
      "startup_timeout_sec = 30",
      "",
      "[mcp_servers.local.env]",
      "MODE = '${LOCAL_MODE}'",
      "",
    ].join("\n"),
  );

  const imported = await run(["import", "--global", "--home", home]);
  assert.equal(imported.code, 0, imported.stderr);
  const written = await json(globalManifest(home));
  assert.deepEqual(written.servers["docs.v2"].headers, { "X-Team": "${DOCS_TEAM}" });
  assert.deepEqual(written.servers.local.args, ["-y", "local-mcp"]);
  assert.deepEqual(written.servers.local.env, { MODE: "${LOCAL_MODE}", LOCAL_TOKEN: "${LOCAL_TOKEN}" });
  assert.equal(written.servers.local.startupTimeoutSec, 30);
  assert.equal(written.servers.not_a_section, undefined);

  assert.equal((await run(["diff", "--global", "--home", home, "--agent", "codex"])).code, 0);

  written.servers["docs.v2"].agents = ["codex", "cursor"];
  await writeFile(globalManifest(home), JSON.stringify(written));
  const synced = await run(["sync", "--global", "--home", home]);
  assert.equal(synced.code, 0, synced.stderr);
  const cursor = await json(join(home, ".cursor", "mcp.json"));
  assert.deepEqual(cursor.mcpServers["docs.v2"].headers, { "X-Team": "${env:DOCS_TEAM}" });
  const codex = await readFile(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codex, /notes = """\n\[not_a_section\]\n"""/);
  assert.match(codex, /\[mcp_servers\."docs\.v2"\]\nurl = "https:\/\/docs\.example\/mcp"\nenv_http_headers = \{ X-Team = "DOCS_TEAM" \}/);
  assert.match(codex, /env_vars = \["LOCAL_TOKEN"\]/);
  assert.match(codex, /\[mcp_servers\.local\.env\]\nMODE = "\$\{LOCAL_MODE\}"/);
  assert.equal((await run(["diff", "--global", "--home", home])).code, 0);
});

test("--home ignores CLAUDE_CONFIG_DIR, CODEX_HOME, and AGENTCFG_CONFIG from the environment", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentcfg-env-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "agentcfg-elsewhere-"));
  await put(globalManifest(home), { version: 1, servers: { docs: { transport: "http", url: "https://example.com/mcp" } } });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: elsewhere, CODEX_HOME: elsewhere, AGENTCFG_CONFIG: join(elsewhere, "x.json") };
  const synced = await run(["sync", "--global", "--home", home], { env });
  assert.equal(synced.code, 0, synced.stderr);
  assert.equal((await json(join(home, ".claude.json"))).mcpServers.docs.url, "https://example.com/mcp");
  assert.deepEqual(await readdir(elsewhere), []);
});
