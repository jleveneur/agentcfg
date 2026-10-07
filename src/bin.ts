#!/usr/bin/env node
import { run } from "./cli.ts"

try {
  const code = await run(process.argv.slice(2))
  if (code) process.exitCode = code
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
