import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
export const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

export async function run(args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [bin, ...args], options);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (caught) {
    const error = caught as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: `${error.stderr ?? ""}${error.message ?? ""}`,
    };
  }
}
