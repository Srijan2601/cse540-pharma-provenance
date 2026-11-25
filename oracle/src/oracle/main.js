#!/usr/bin/env node
/**
 * Executable entry point of the oracle (npm run oracle, npm run oracle:once,
 * npm run oracle:check). It does what only a real process should do and
 * leaves everything else to cli.js:
 *   - load oracle/.env if the user created one (variables already set in the
 *     environment win; no file is required);
 *   - turn SIGINT / SIGTERM into a clean shutdown of the monitor: the step in
 *     progress (for example a transaction waiting for its receipt) finishes,
 *     nothing new is started, a summary line is printed;
 *   - set the process exit code.
 */

import { loadEnvFile } from "../config.js";
import { OracleError } from "../errors.js";
import { runOracleCli } from "./cli.js";

/**
 * One Ctrl+C can reach this process twice: the terminal signals the whole
 * foreground process group, and "npm run" forwards the same signal to its
 * child as well. Both copies arrive within milliseconds, so a repeat this
 * soon after the first signal is the same Ctrl+C, not a second one.
 */
const DUPLICATE_SIGNAL_MS = 500;

const args = process.argv.slice(2);
const shutdown = new AbortController();
if (args[0] === "monitor") {
  // Only the long-running command intercepts signals; for "once" and "check" Ctrl+C keeps its usual meaning.
  let firstSignalAt = null;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (firstSignalAt === null) {
        firstSignalAt = Date.now();
        shutdown.abort();
      } else if (Date.now() - firstSignalAt > DUPLICATE_SIGNAL_MS) {
        // A real second Ctrl+C: give the signal back to Node's default handler, which ends the process immediately.
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      }
    });
  }
}

try {
  loadEnvFile();
  process.exitCode = await runOracleCli(args, { signal: shutdown.signal });
} catch (error) {
  // Known failures (for example an invalid variable in .env) are explained in one message;
  // anything else is a defect, and its stack trace is what a maintainer needs.
  process.stderr.write(error instanceof OracleError ? `error: ${error.message}\n` : `${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
