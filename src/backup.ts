import { copyFile, mkdir } from "node:fs/promises"
import { dirname, join, parse } from "node:path"

import { fileExists } from "./files.ts"

// Copies every file a sync is about to change into one timestamped folder,
// mirroring absolute paths, before the first write.
export class Backup {
  readonly dir: string
  readonly saved: string[] = []

  constructor(stateDir: string, now = new Date()) {
    this.dir = join(stateDir, "backups", now.toISOString().replace(/[:.]/g, "-"))
  }

  async save(file: string): Promise<void> {
    if (this.saved.includes(file) || !(await fileExists(file))) return
    const target = join(this.dir, file.slice(parse(file).root.length))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file, target)
    this.saved.push(file)
  }
}
