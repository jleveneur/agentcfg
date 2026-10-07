import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
export const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))

export async function run(args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [bin, ...args], options)
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (caught) {
    const error = caught as { code?: number; stdout?: string; stderr?: string; message?: string }
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: `${error.stderr ?? ""}${error.message ?? ""}`
    }
  }
}

export async function put(file: string, content: unknown) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content, null, 2))
}

// Tests read back JSON written by agentcfg and look into it freely.
// oxlint-disable-next-line typescript/no-explicit-any
export async function json(file: string): Promise<any> {
  return JSON.parse(await readFile(file, "utf8"))
}
