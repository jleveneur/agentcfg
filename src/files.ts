import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export function parseJson(text: string | null, file: string): Record<string, unknown> {
  if (text == null || !text.trim()) return {}
  try {
    const data: unknown = JSON.parse(text)
    return isRecord(data) ? data : {}
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${errorMessage(error)}`, { cause: error })
  }
}

export async function readJson(file: string): Promise<Record<string, unknown>> {
  return parseJson(await readText(file), file)
}

const SCALAR = String.raw`(?:"(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)`
const SCALAR_ARRAY = new RegExp(String.raw`\[\n\s+(${SCALAR}(?:,\n\s+${SCALAR})*)\n\s*\]`, "g")

// Two-space JSON with short arrays of scalars kept on one line, the way
// people write `"args": ["-y", "server"]` by hand. Keeps diffs small.
export function formatJson(data: unknown): string {
  const text = JSON.stringify(data, null, 2).replace(SCALAR_ARRAY, (match, items: string) => {
    const inline = `[${items.split(/,\n\s+/).join(", ")}]`
    return inline.length <= 80 ? inline : match
  })
  return `${text}\n`
}

export interface Saver {
  save(file: string): Promise<void>
}

const ATTEMPTS = 5

// Read, transform, write, but only if nobody wrote the file in between.
// Claude Code rewrites ~/.claude.json while it runs, so a plain
// read-modify-write could drop its change or have it drop ours. Returns
// whether the file changed.
export async function updateText(
  file: string,
  transform: (text: string | null) => string | null,
  backup?: Saver
): Promise<boolean> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    // Each attempt depends on what the previous one found on disk.
    // oxlint-disable-next-line no-await-in-loop
    const before = await readText(file)
    const next = transform(before)
    if (next == null || next === before) return false
    // oxlint-disable-next-line no-await-in-loop
    await backup?.save(file)
    // oxlint-disable-next-line no-await-in-loop
    if (await replaceIfUnchanged(file, before, next)) return true
  }
  throw new Error(
    `${file} kept changing while agentcfg was writing it. Quit the app that writes it and try again.`
  )
}

export function updateJson(
  file: string,
  mutate: (data: Record<string, unknown>) => Record<string, unknown>,
  backup?: Saver
): Promise<boolean> {
  return updateText(
    file,
    (text) => {
      const data = parseJson(text, file)
      const next = mutate(structuredClone(data))
      return JSON.stringify(next) === JSON.stringify(data) ? null : formatJson(next)
    },
    backup
  )
}

// Writes through a temp file so a crash never leaves a half-written config,
// keeps the original permissions (~/.claude.json is 0600), and gives up when
// the file no longer holds what the caller read.
async function replaceIfUnchanged(
  file: string,
  expected: string | null,
  content: string
): Promise<boolean> {
  await mkdir(dirname(file), { recursive: true })
  const mode = await fileMode(file)
  const temp = `${file}.agentcfg-${process.pid}.tmp`
  await writeFile(temp, content, mode == null ? undefined : { mode })
  if (mode != null) await chmod(temp, mode)
  if ((await readText(file)) !== expected) {
    await rm(temp, { force: true })
    return false
  }
  await rename(temp, file)
  return true
}

export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const mode = await fileMode(file)
  const temp = `${file}.agentcfg-${process.pid}.tmp`
  await writeFile(temp, content, mode == null ? undefined : { mode })
  if (mode != null) await chmod(temp, mode)
  await rename(temp, file)
}

async function fileMode(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mode & 0o777
  } catch {
    return null
  }
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function isMissing(error: unknown): boolean {
  const code = isRecord(error) ? error.code : undefined
  return code === "ENOENT" || code === "ENOTDIR"
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
