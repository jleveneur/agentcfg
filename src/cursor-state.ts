import { fileURLToPath } from "node:url"

import { errorMessage, fileExists, isRecord } from "./files.ts"

// Which Cursor plugins are installed, by Cursor's own record: the
// cursor.plugins.installedIds.* keys of its state database. "user" holds
// installs that apply everywhere; the other keys are workspace paths.
export interface CursorInstalls {
  user: string[]
  workspaces: Record<string, { id: string; fromProject: boolean }[]>
}

interface Row {
  key: string
  value: string
}

interface Database {
  prepare(sql: string): { all(): unknown[] }
  close(): void
}

type DatabaseConstructor = new (path: string, options: { readOnly: boolean }) => Database

// node:sqlite prints an ExperimentalWarning on load in some Node versions.
// It would land in the middle of the scan report, so it is silenced for the
// import only.
async function loadSqlite(): Promise<DatabaseConstructor | null> {
  // Restored as is below, so it is never called detached from process.
  // oxlint-disable-next-line typescript/unbound-method
  const original = process.emitWarning
  process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message
    if (/sqlite/i.test(text)) return
    Reflect.apply(original, process, [warning, ...rest])
  }
  try {
    const sqlite: { DatabaseSync?: DatabaseConstructor } = await import("node:sqlite")
    return sqlite.DatabaseSync ?? null
  } catch {
    return null
  } finally {
    process.emitWarning = original
  }
}

export async function readCursorInstalls(file: string): Promise<CursorInstalls | null> {
  if (!(await fileExists(file))) return null
  const DatabaseSync = await loadSqlite()
  if (!DatabaseSync) return null
  let rows: unknown[]
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      rows = db
        .prepare("select key, value from ItemTable where key like 'cursor.plugins.installedIds.%'")
        .all()
    } finally {
      db.close()
    }
  } catch (error) {
    throw new Error(`could not read ${file}: ${errorMessage(error)}`, { cause: error })
  }
  return parseInstalls(rows.filter(isRow))
}

function isRow(value: unknown): value is Row {
  return isRecord(value) && typeof value.key === "string" && typeof value.value === "string"
}

export function parseInstalls(rows: Row[]): CursorInstalls {
  const installs: CursorInstalls = { user: [], workspaces: {} }
  for (const { key, value } of rows) {
    const workspace = key.slice(key.indexOf("|") + 1)
    let entries: unknown
    try {
      entries = JSON.parse(value)
    } catch {
      continue
    }
    if (!Array.isArray(entries)) continue
    const ids = entries.filter(isRecord).flatMap((entry) => {
      if (typeof entry.id !== "string") return []
      const sources = Array.isArray(entry.sources) ? entry.sources : []
      return [
        {
          id: entry.id,
          fromProject: sources.includes("project"),
          fromUser: sources.includes("user")
        }
      ]
    })
    if (workspace === "no-workspace") {
      installs.user = ids.filter((entry) => entry.fromUser).map((entry) => entry.id)
      continue
    }
    // A multi-root workspace is a comma-separated list of folder URLs.
    for (const url of workspace.split(",")) {
      if (!url.startsWith("file://")) continue
      installs.workspaces[fileURLToPath(url)] = ids.map(({ id, fromProject }) => ({
        id,
        fromProject
      }))
    }
  }
  return installs
}
