#!/usr/bin/env node
import { run } from "../src/cli.js";

run(process.argv.slice(2))
  .then((code) => {
    if (code) process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
