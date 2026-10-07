#!/usr/bin/env node
import { run } from "./cli.ts";

run(process.argv.slice(2))
  .then((code) => {
    if (code) process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
