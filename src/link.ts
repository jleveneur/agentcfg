import { lstat, mkdir, readdir, readlink, realpath, rmdir, symlink, unlink } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

import type { CommandOptions } from "./commands.ts"
import { fileExists, readJson } from "./files.ts"
import { findProjectManifest } from "./paths.ts"

export interface LinkAction {
  kind: "create-dir" | "link-dir" | "link-skill" | "remove-link" | "keep"
  path: string
  target?: string
  reason?: string
}

export interface LinkResult {
  root: string
  global: boolean
  skills: string[]
  actions: LinkAction[]
}

// Claude Code reads .claude/skills; every other agent reads .agents/skills.
// In a project with no .claude/skills, one link to .agents/skills covers
// every skill, now and later. Otherwise, and always in the home directory
// (where Claude Code keeps its own synced/ folder), each skill gets its own
// link and nothing already there is touched.
export async function linkSkills(options: CommandOptions): Promise<LinkResult> {
  const global = options.global === true
  const manifest = global ? null : await findProjectManifest(options.dir, options.ctx)
  const root = global
    ? resolve(options.ctx.home)
    : manifest
      ? dirname(manifest)
      : resolve(options.dir)
  if (manifest && !options.force) {
    const agents = (await readJson(manifest)).agents
    if (Array.isArray(agents) && !agents.includes("claude")) {
      throw new Error(
        `${manifest} does not list claude in its agents, so there is nothing to link. Pass --force to link anyway.`
      )
    }
  }
  const shared = join(root, ".agents", "skills")
  const claude = join(root, ".claude", "skills")
  const skills = await skillNames(shared)
  const actions: LinkAction[] = []

  const existing = await lstat(claude).catch(() => null)
  if (!global && !existing) {
    if (!(await fileExists(shared))) actions.push({ kind: "create-dir", path: shared })
    actions.push({ kind: "link-dir", path: claude, target: relative(dirname(claude), shared) })
  } else if (existing?.isSymbolicLink()) {
    const target = await realpath(claude).catch(() => null)
    const sharedReal = await realpath(shared).catch(() => null)
    actions.push(
      target && target === sharedReal
        ? { kind: "keep", path: claude, reason: "already links to .agents/skills" }
        : { kind: "keep", path: claude, reason: `links to ${await readlink(claude)}, left alone` }
    )
  } else {
    if (!existing) actions.push({ kind: "create-dir", path: claude })
    actions.push(...(await skillLinks(claude, shared, skills)))
  }

  if (!options.dryRun) await apply(actions)
  return { root, global, skills, actions }
}

async function skillLinks(claude: string, shared: string, skills: string[]): Promise<LinkAction[]> {
  const actions: LinkAction[] = []
  for (const name of skills) {
    const path = join(claude, name)
    const target = join(shared, name)
    // oxlint-disable-next-line no-await-in-loop
    const entry = await lstat(path).catch(() => null)
    if (!entry) {
      actions.push({ kind: "link-skill", path, target: relative(claude, target) })
      continue
    }
    // oxlint-disable-next-line no-await-in-loop
    const [real, wanted] = await Promise.all([realpath(path).catch(() => null), realpath(target)])
    actions.push(
      real === wanted
        ? { kind: "keep", path, reason: "already linked" }
        : { kind: "keep", path, reason: "Claude Code's own copy, left alone" }
    )
  }
  // Links this command made earlier to skills since removed.
  for (const entry of await readdir(claude, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isSymbolicLink()) continue
    const path = join(claude, entry.name)
    // oxlint-disable-next-line no-await-in-loop
    const target = resolve(claude, await readlink(path))
    // oxlint-disable-next-line no-await-in-loop
    if (target.startsWith(`${shared}${sep}`) && !(await fileExists(target))) {
      actions.push({ kind: "remove-link", path, reason: "its skill is gone from .agents/skills" })
    }
  }
  return actions
}

async function skillNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const names = await Promise.all(
    entries
      .filter(
        (entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink())
      )
      .map(async (entry) =>
        (await fileExists(join(dir, entry.name, "SKILL.md"))) ? entry.name : null
      )
  )
  return names.filter((name): name is string => name !== null).toSorted()
}

// Windows needs administrator rights for symbolic links, but not for
// directory junctions, which take an absolute target.
function link(target: string, path: string): Promise<void> {
  if (process.platform === "win32") return symlink(resolve(dirname(path), target), path, "junction")
  return symlink(target, path, "dir")
}

async function apply(actions: LinkAction[]): Promise<void> {
  // In order: a folder is created before the links that go in it.
  for (const action of actions) {
    if (action.kind === "create-dir") {
      // oxlint-disable-next-line no-await-in-loop
      await mkdir(action.path, { recursive: true })
    } else if ((action.kind === "link-dir" || action.kind === "link-skill") && action.target) {
      // oxlint-disable-next-line no-await-in-loop
      await mkdir(dirname(action.path), { recursive: true })
      // oxlint-disable-next-line no-await-in-loop
      await link(action.target, action.path)
    } else if (action.kind === "remove-link") {
      // A Windows junction comes off with rmdir, a symbolic link with unlink.
      // oxlint-disable-next-line no-await-in-loop
      await unlink(action.path).catch(() => rmdir(action.path))
    }
  }
}
