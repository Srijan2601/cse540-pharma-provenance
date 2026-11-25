#!/usr/bin/env node
/**
 * Executable entry point of the command-line tool (npm run ipfs, npm run
 * service, ...). It does the three things that only a real process should do
 * and leaves everything else to commands.js:
 *   - load oracle/.env if the user created one (variables already set in the
 *     environment win; no file is required);
 *   - turn SIGINT / SIGTERM into a graceful shutdown of `serve`;
 *   - set the process exit code.
 */

import { loadEnvFile } from "../config.js";
import { OracleError } from "../errors.js";
import { runCli } from "./commands.js";

const args = process.argv.slice(2);
const shutdown = new AbortController();
if (args[0] === "serve") {
  // Only the long-running command intercepts signals; for the others Ctrl+C keeps its usual meaning.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    // "once": a second Ctrl+C falls through to Node's default handler and ends the process immediately.
    process.once(signal, () => shutdown.abort());
  }
}

try {
  loadEnvFile();
  process.exitCode = await runCli(args, { signal: shutdown.signal });
} catch (error) {
  // Known failures (for example an invalid variable in .env) are explained in one message;
  // anything else is a defect, and its stack trace is what a maintainer needs.
  process.stderr.write(error instanceof OracleError ? `error: ${error.message}\n` : `${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
