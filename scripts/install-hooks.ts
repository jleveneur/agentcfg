/**
 * Installs Git hooks via Lefthook.
 *
 * Deliberately never fails the install. Hooks are a convenience that catches
 * trivia before it costs a CI cycle; CI is the actual gate. So a machine that
 * cannot install hooks — CI containers, sandboxes, restricted `.git` permissions,
 * a starter downloaded as a ZIP with no `.git` at all — must still be able to
 * run `pnpm install`.
 *
 * Run automatically by the root `prepare` script.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")

if (process.env["CI"] !== undefined) {
  console.log("• Skipping Git hooks: CI runs the checks directly.")
  process.exit(0)
}

if (!existsSync(resolve(ROOT, ".git"))) {
  console.log("• Skipping Git hooks: not a Git working tree.")
  process.exit(0)
}

const result = spawnSync("lefthook", ["install"], {
  cwd: ROOT,
  stdio: "pipe",
  encoding: "utf8",
  shell: false
})

if (result.status === 0) {
  console.log("✓ Git hooks installed.")
  process.exit(0)
}

const detail = (result.stderr || result.error?.message || "unknown error").trim().split("\n")[0]

console.warn(
  [
    "",
    `⚠ Could not install Git hooks: ${detail ?? "unknown error"}`,
    "",
    "  Continuing anyway — hooks are a convenience, not a gate. Run `pnpm check`",
    "  before pushing, or `pnpm exec lefthook install` once the cause is fixed.",
    ""
  ].join("\n")
)

process.exit(0)
