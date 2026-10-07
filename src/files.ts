import { access, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function readJson(file: string): Promise<Record<string, unknown>> {
  const text = await readText(file);
  if (text == null) return {};
  try {
    const data: unknown = JSON.parse(text);
    return isRecord(data) ? data : {};
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await writeFileAtomic(file, formatJson(data));
}

const SCALAR = String.raw`(?:"(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)`;
const SCALAR_ARRAY = new RegExp(String.raw`\[\n\s+(${SCALAR}(?:,\n\s+${SCALAR})*)\n\s*\]`, "g");

// Two-space JSON with short arrays of scalars kept on one line, the way
// people write `"args": ["-y", "server"]` by hand. Keeps diffs small.
export function formatJson(data: unknown): string {
  const text = JSON.stringify(data, null, 2).replace(SCALAR_ARRAY, (match, items: string) => {
    const inline = `[${items.split(/,\n\s+/).join(", ")}]`;
    return inline.length <= 80 ? inline : match;
  });
  return `${text}\n`;
}

// Writes through a temp file so a crash never leaves a half-written config,
// and keeps the original permissions (~/.claude.json is 0600).
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const mode = await stat(file).then((info) => info.mode & 0o777, () => null);
  const temp = `${file}.agentcfg-${process.pid}.tmp`;
  await writeFile(temp, content, mode == null ? undefined : { mode });
  if (mode != null) await chmod(temp, mode);
  await rename(temp, file);
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
