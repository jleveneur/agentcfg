import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"

import { frontmatter } from "../src/skills.ts"
import { put, run } from "./helpers.ts"

const skill = (dir: string, name: string, body = "") =>
  put(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`)

// Matches how link.ts makes links, so the test runs on Windows too.
const linkDir = (target: string, path: string) =>
  process.platform === "win32"
    ? symlink(resolve(path, "..", target), path, "junction")
    : symlink(target, path, "dir")

void test("frontmatter reads plain and folded values", () => {
  const meta = frontmatter(
    '---\nname: verify\ndescription: >-\n  Runs the checks\n  before a commit.\nversion: "1.2.0"\n---\nbody'
  )
  assert.deepEqual(meta, {
    name: "verify",
    description: "Runs the checks before a commit.",
    version: "1.2.0"
  })
  assert.deepEqual(frontmatter("no front matter"), {})
})

void test("scan lists skills, the copies an agent loads twice, and the ones it cannot see", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcfg-skills-"))
  const home = join(root, "home")
  const app = join(home, "code", "app")
  await put(join(app, "agentcfg.json"), { version: 1, servers: {} })
  await skill(join(home, ".agents", "skills"), "find-skills")
  await skill(join(app, ".agents", "skills"), "shadcn")
  await skill(join(app, ".agents", "skills"), "review", "v1")
  await skill(join(app, ".cursor", "skills"), "review", "v2")
  await skill(join(app, ".cursor", "skills"), "design")
  await skill(join(home, ".cursor", "skills-cursor"), "builtin-one")

  const result = await run(["scan", "--home", home, "--projects", join(home, "code"), "--json"])
  assert.equal(result.code, 0, result.stderr)
  const { skills } = JSON.parse(result.stdout) as {
    skills: {
      locations: { dir: string; skills: { name: string }[] }[]
      builtIn: { agent: string; count: number }[]
      conflicts: { agent: string; name: string; sameContent: boolean }[]
      gaps: { agent: string; location: { dir: string }; missing: string[] }[]
    }
  }
  const real = await realpath(app)
  assert.deepEqual(skills.builtIn, [{ agent: "cursor", count: 1 }])
  assert.deepEqual(
    skills.conflicts.map((c) => `${c.agent} ${c.name} ${c.sameContent}`),
    ["cursor review false"]
  )
  const gaps = skills.gaps.map(
    (g) =>
      `${g.agent} ${g.location.dir.replace(real, "app").replace(app, "app")} ${g.missing.join(",")}`
  )
  assert.ok(
    gaps.includes(`claude ${join("app", ".agents", "skills")} review,shadcn`),
    gaps.join("\n")
  )
  assert.ok(gaps.includes(`codex ${join("app", ".cursor", "skills")} design`), gaps.join("\n"))
  assert.ok(
    gaps.some((g) => g.startsWith("claude ") && g.endsWith("find-skills")),
    gaps.join("\n")
  )

  const text = await run(["scan", "--home", home, "--projects", join(home, "code")])
  assert.match(text.stdout, /Skills: 5 in 3 folders, 0 from plugins, 1 built in \(cursor 1\)\./)
  assert.match(text.stdout, /app +review +2 different versions for cursor/)
  assert.match(
    text.stdout,
    /claude +app\/\.agents\/skills +2 skills: review, shadcn +run agentcfg link in app/
  )
  assert.match(
    text.stdout,
    /codex +app\/\.cursor\/skills +1 skill: design +move to \.agents\/skills/
  )

  // Once linked, Claude Code sees the shared skills and nothing is flagged
  // twice for the agents that read both folders.
  assert.equal((await run(["link", "--home", home], { cwd: app })).code, 0)
  const after = await run(["scan", "--home", home, "--projects", join(home, "code")])
  assert.doesNotMatch(after.stdout, /run agentcfg link in app/)
  assert.match(after.stdout, /app\/\.claude\/skills → .*\.agents\/skills +2 +read by claude/)
})

void test("link makes one folder link in a project, and per-skill links next to existing ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcfg-link-"))
  const home = join(root, "home")
  const app = join(root, "app")
  await skill(join(app, ".agents", "skills"), "shadcn")

  const dry = await run(["link", "--dry-run", "--home", home], { cwd: app })
  assert.match(dry.stdout, /would link \.claude\/skills → \.\.\/\.agents\/skills/)
  assert.equal(await lstat(join(app, ".claude")).catch(() => null), null)

  const linked = await run(["link", "--home", home], { cwd: app })
  assert.equal(linked.code, 0, linked.stderr)
  assert.equal((await lstat(join(app, ".claude", "skills"))).isSymbolicLink(), true)
  assert.equal(
    await realpath(join(app, ".claude", "skills")),
    await realpath(join(app, ".agents", "skills"))
  )
  assert.match(
    (await run(["link", "--home", home], { cwd: app })).stdout,
    /kept \.claude\/skills: already links/
  )

  // A project that already has Claude-only skills keeps them; the shared
  // ones get a link each, and a link to a removed skill goes away.
  const other = join(root, "other")
  await skill(join(other, ".agents", "skills"), "shadcn")
  await skill(join(other, ".agents", "skills"), "verify")
  await skill(join(other, ".claude", "skills"), "verify", "claude version")
  await skill(join(other, ".claude", "skills"), "claude-only")
  await mkdir(join(other, ".agents", "skills", "old"), { recursive: true })
  await linkDir(
    join("..", "..", ".agents", "skills", "old"),
    join(other, ".claude", "skills", "old")
  )
  await rm(join(other, ".agents", "skills", "old"), { recursive: true })

  const result = await run(["link", "--home", home], { cwd: other })
  assert.equal(result.code, 0, result.stderr)
  assert.match(
    result.stdout,
    /linked \.claude\/skills\/shadcn → \.\.\/\.\.\/\.agents\/skills\/shadcn/
  )
  assert.match(result.stdout, /kept \.claude\/skills\/verify: Claude Code's own copy/)
  assert.match(result.stdout, /removed \.claude\/skills\/old: its skill is gone/)
  assert.equal(
    await realpath(join(other, ".claude", "skills", "shadcn")),
    await realpath(join(other, ".agents", "skills", "shadcn"))
  )
  assert.equal((await lstat(join(other, ".claude", "skills", "verify"))).isSymbolicLink(), false)
  assert.equal((await lstat(join(other, ".claude", "skills", "claude-only"))).isDirectory(), true)
  assert.equal(await lstat(join(other, ".claude", "skills", "old")).catch(() => null), null)
})

void test("link --global links each skill and leaves Claude Code's synced folder alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcfg-link-global-"))
  const home = join(root, "home")
  await skill(join(home, ".agents", "skills"), "find-skills")
  await skill(join(home, ".claude", "skills", "synced"), "from-claude-ai")

  const result = await run(["link", "--global", "--home", home], { cwd: root })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /linked ~\/\.claude\/skills\/find-skills/)
  assert.equal(
    await readlink(join(home, ".claude", "skills", "find-skills")).then(() => true),
    true
  )
  assert.equal((await lstat(join(home, ".claude", "skills", "synced"))).isDirectory(), true)
  assert.equal((await lstat(join(home, ".claude", "skills"))).isSymbolicLink(), false)
})

void test("link refuses a project whose manifest leaves out claude", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcfg-link-agents-"))
  const app = join(root, "app")
  await put(join(app, "agentcfg.json"), { version: 1, agents: ["cursor", "codex"], servers: {} })
  const result = await run(["link", "--home", join(root, "home")], { cwd: app })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /does not list claude/)
})
