#!/usr/bin/env node
/**
 * Executable entry point of "npm run simulate". It loads oracle/.env if the
 * user created one (so SIM_SEED and friends set there apply), runs the
 * command in cli.js and sets the process exit code. The command itself never
 * touches the chain or IPFS.
 */

import { loadEnvFile } from "../config.js";
import { OracleError } from "../errors.js";
import { runSimulateCli } from "./cli.js";

try {
  loadEnvFile();
  process.exitCode = await runSimulateCli(process.argv.slice(2));
} catch (error) {
  // A known failure is explained in one message; anything else is a defect and keeps its stack trace.
  process.stderr.write(error instanceof OracleError ? `error: ${error.message}\n` : `${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
