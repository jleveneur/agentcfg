import { createHash } from "node:crypto"
import { readdir, readFile, realpath } from "node:fs/promises"
import { join } from "node:path"

import type { Locations } from "./paths.ts"

// Where each agent looks for skills, from their docs: Claude Code reads only
// .claude/skills; Codex, Gemini CLI, VS Code, and Cursor all read
// .agents/skills. Cursor's list comes from its own code, and it reads the
// .claude and .codex folders through its default-on third-party import.
const PROJECT_DIRS: { rel: string; readBy: string[] }[] = [
  { rel: ".agents/skills", readBy: ["codex", "gemini", "vscode", "cursor"] },
  { rel: ".claude/skills", readBy: ["claude", "vscode", "cursor"] },
  { rel: ".cursor/skills", readBy: ["cursor"] },
  { rel: ".gemini/skills", readBy: ["gemini"] },
  { rel: ".github/skills", readBy: ["vscode"] },
  { rel: ".codex/skills", readBy: ["cursor"] }
]

const USER_DIRS: { rel: string; readBy: string[] }[] = [
  { rel: ".agents/skills", readBy: ["codex", "gemini", "vscode", "cursor"] },
  { rel: ".claude/skills", readBy: ["claude", "vscode", "cursor"] },
  { rel: ".cursor/skills", readBy: ["cursor"] },
  { rel: ".gemini/skills", readBy: ["gemini"] },
  { rel: ".copilot/skills", readBy: ["vscode"] },
  // Codex's older user folder. It now holds only its bundled .system skills.
  { rel: ".codex/skills", readBy: ["cursor"] }
]

// Skills an agent ships with.
const BUILT_IN: { rel: string; agent: string }[] = [
  { rel: ".cursor/skills-cursor", agent: "cursor" },
  { rel: ".codex/skills/.system", agent: "codex" }
]

export interface Skill {
  name: string
  description?: string
  dir: string
  realDir: string
  // Hash of SKILL.md, to tell copies from different skills of one name.
  hash: string
}

export interface SkillLocation {
  dir: string
  scope: "user" | "project" | "plugin"
  project?: string
  plugin?: string
  readBy: string[]
  // Set when the folder itself is a link, as .claude/skills → .agents/skills.
  linkedTo?: string
  skills: Skill[]
}

export interface SkillConflict {
  agent: string
  project?: string
  name: string
  places: string[]
  sameContent: boolean
}

export interface SkillGap {
  agent: string
  location: SkillLocation
  missing: string[]
}

export interface SkillsReport {
  locations: SkillLocation[]
  builtIn: { agent: string; count: number }[]
  conflicts: SkillConflict[]
  gaps: SkillGap[]
}

export interface PluginSkills {
  agent: string
  plugin: string
  dir: string
  active: boolean
}

export async function collectSkills(input: {
  home: string
  paths: Locations
  projects: string[]
  // The agents each project is expected to work with.
  agentsFor: (project: string | null) => string[]
  plugins: PluginSkills[]
}): Promise<SkillsReport> {
  const locations: SkillLocation[] = []
  const add = async (location: Omit<SkillLocation, "skills" | "linkedTo">) => {
    const found = await readSkillDir(location.dir)
    if (!found || (location.scope === "plugin" && !found.skills.length)) return
    locations.push({ ...location, ...found })
  }
  for (const { rel, readBy } of USER_DIRS) {
    await add({ dir: join(input.home, rel), scope: "user", readBy })
  }
  for (const project of input.projects) {
    for (const { rel, readBy } of PROJECT_DIRS) {
      await add({ dir: join(project, rel), scope: "project", project, readBy })
    }
  }
  for (const plugin of input.plugins.filter((entry) => entry.active)) {
    await add({
      dir: join(plugin.dir, "skills"),
      scope: "plugin",
      plugin: plugin.plugin,
      readBy: [plugin.agent]
    })
  }

  const builtIn = []
  for (const { rel, agent } of BUILT_IN) {
    const found = await readSkillDir(join(input.home, rel))
    if (found?.skills.length) builtIn.push({ agent, count: found.skills.length })
  }

  // A project shares nothing with another, so conflicts and gaps are
  // checked per project, each with the user folders.
  const user = locations.filter((location) => location.scope === "user")
  const conflicts: SkillConflict[] = []
  const gaps: SkillGap[] = []
  const scopes: (string | null)[] = [null, ...input.projects]
  for (const project of scopes) {
    const own = project ? locations.filter((location) => location.project === project) : user
    const visible = project ? [...user, ...own] : user
    for (const agent of input.agentsFor(project)) {
      conflicts.push(...findConflicts(agent, project, visible))
      for (const location of own) {
        if (location.readBy.includes(agent) || !location.skills.length) continue
        const seen = new Set(
          visible
            .filter((other) => other.readBy.includes(agent))
            .flatMap((other) => other.skills.map((skill) => skill.name))
        )
        const missing = location.skills.map((skill) => skill.name).filter((name) => !seen.has(name))
        if (missing.length) gaps.push({ agent, location, missing })
      }
    }
  }
  return { locations, builtIn, conflicts, gaps }
}

// Two different folders that give one agent the same skill name.
function findConflicts(
  agent: string,
  project: string | null,
  visible: SkillLocation[]
): SkillConflict[] {
  const byName = new Map<string, Skill[]>()
  for (const location of visible) {
    if (!location.readBy.includes(agent)) continue
    for (const skill of location.skills) {
      byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill])
    }
  }
  const out: SkillConflict[] = []
  for (const [name, skills] of byName) {
    const places = [...new Set(skills.map((skill) => skill.realDir))]
    if (places.length < 2) continue
    out.push({
      agent,
      ...(project ? { project } : {}),
      name,
      places,
      sameContent: new Set(skills.map((skill) => skill.hash)).size === 1
    })
  }
  return out
}

async function readSkillDir(dir: string): Promise<{ skills: Skill[]; linkedTo?: string } | null> {
  let real: string
  try {
    real = await realpath(dir)
  } catch {
    return null
  }
  const entries = await readdir(real, { withFileTypes: true }).catch(() => [])
  const skills = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map(async (entry) => readSkill(join(dir, entry.name)))
  )
  return {
    skills: skills.filter((skill): skill is Skill => skill !== null),
    ...(real === dir ? {} : { linkedTo: real })
  }
}

async function readSkill(dir: string): Promise<Skill | null> {
  try {
    const realDir = await realpath(dir)
    const text = await readFile(join(realDir, "SKILL.md"), "utf8")
    const meta = frontmatter(text)
    const name =
      typeof meta.name === "string" && meta.name ? meta.name : (dir.split(/[\\/]/).pop() ?? dir)
    return {
      name,
      ...(typeof meta.description === "string" ? { description: meta.description } : {}),
      dir,
      realDir,
      hash: createHash("sha256").update(text).digest("hex")
    }
  } catch {
    return null
  }
}

// The `key: value` lines of a SKILL.md front matter, with YAML block
// scalars (`>-`, `|`) folded into one line. Enough for name and description.
export function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const out: Record<string, string> = {}
  if (!match?.[1]) return out
  const lines = match[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!pair?.[1]) continue
    let value = (pair[2] ?? "").trim()
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = []
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1] ?? "")) {
        index += 1
        block.push((lines[index] ?? "").trim())
      }
      value = block.join(" ")
    }
    out[pair[1]] = value.replace(/^(["'])(.*)\1$/, "$2")
  }
  return out
}
