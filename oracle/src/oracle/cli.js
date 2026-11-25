/**
 * The oracle's command line, kept apart from the executable (main.js) so
 * tests can run every command in-process with captured output and a fake
 * registry.
 *
 *   monitor   watch lots and anchor their sensor logs until stopped   (npm run oracle)
 *   once      anchor one log for one lot now, with a chosen scenario   (npm run oracle:once)
 *   check     run the pre-flight checks and exit                       (npm run oracle:check)
 *
 * Conventions (the same as the IPFS tool in src/cli/):
 *   - Results go to stdout, one line per action. Retries, waits and failures
 *     go to stderr.
 *   - Exit code 0 = done; 1 = a configuration or pre-flight error, or, for
 *     "once", the one requested log was not anchored; 2 = the command line
 *     was wrong. "monitor" keeps running through per-lot failures and exits
 *     0 when it is stopped: a failing lot is reported, not fatal.
 *   - Options choose what to do in this run (which lots, which scenario).
 *     Everything about the environment (network, keys, sample interval, log
 *     size, K) comes from environment variables through src/config.js.
 */

import { parseArgs } from "node:util";

import { loadConfig } from "../config.js";
import { createDocuments } from "../documents/index.js";
import { OracleError, UsageError } from "../errors.js";
import { createStorage } from "../ipfs/index.js";
import { SCENARIO_NAMES, SCENARIOS } from "../simulator/scenarios.js";
import { formatEvent, formatEventJson, isDiagnostic } from "./format.js";
import { connectRegistry } from "./registryClient.js";
import { abortableSleep } from "./retry.js";
import { createOracleRunner, systemClock } from "./runner.js";

const SCENARIO_LIST = SCENARIO_NAMES.map((name) => `      ${name.padEnd(10)} ${SCENARIOS[name].summary}`).join("\n");

const ENVIRONMENT_NOTE = `Environment (all optional; see the README for the full table)
  NETWORK               localhost (default) or amoy; selects ../deployments/<NETWORK>.json
  RPC_URL               JSON-RPC endpoint (default http://127.0.0.1:8545 for localhost)
  ORACLE_PRIVATE_KEY    key of the wallet that holds ORACLE_ROLE; not needed on the local node (account #4 signs)
  SIM_SEED              seed of the simulated sensors (default 540)
  SIM_SAMPLE_SECONDS    seconds between two readings (default 60)
  SIM_LOG_SIZE          readings per sensor log (default 12)
  EXCURSION_RUN_LENGTH  K: consecutive out-of-range readings that trigger a report (default 3)`;

export const ORACLE_USAGE = `Usage: node src/oracle/main.js <command> [options]

Commands
  monitor   Watch lots; anchor one sensor log per lot every SIM_LOG_SIZE readings,
            or report an excursion as soon as the rule triggers.        (npm run oracle)
  once      Anchor one sensor log for one lot now, with a chosen scenario.
            This is how an excursion is triggered on demand.            (npm run oracle:once -- --lot <id>)
  check     Run the pre-flight checks (RPC, chain id, contract code,
            signer, ORACLE_ROLE) and exit.                              (npm run oracle:check)

Run "<command> --help" for the options of a command.

${ENVIRONMENT_NOTE}`;

export const MONITOR_USAGE = `Usage: npm run oracle -- [options]        (node src/oracle/main.js monitor [options])

Watches lots until stopped with Ctrl+C. Every SIM_SAMPLE_SECONDS it takes one simulated
reading per watched lot. A lot's readings are closed into a sensor log, uploaded to IPFS
and anchored with anchorSensorLog when SIM_LOG_SIZE readings are collected. When
EXCURSION_RUN_LENGTH consecutive readings are out of the lot's range, the log is closed at
once and sent with reportExcursion instead, which makes the lot Compromised.
A lot is dropped from the watch list when it is no longer active.

Options
  --lots <ids>             watch exactly these lots, e.g. --lots 1,3 (default: every active lot,
                           including lots registered while the monitor runs)
  --scenario <name>        scenario of every watched lot (default: normal)
  --scenario <lot>=<name>  scenario of one lot; may be repeated, e.g. --scenario 2=excursion
  --cycles <n>             stop after n log periods (n x SIM_LOG_SIZE readings); default: run until stopped
  --json                   print one JSON object per line instead of text
  --help                   show this text

Scenarios
${SCENARIO_LIST}

Exit status: 0 when stopped (failures of single lots are reported, not fatal);
1 for a configuration or pre-flight error; 2 for a wrong command line.

${ENVIRONMENT_NOTE}`;

export const ONCE_USAGE = `Usage: npm run oracle:once -- --lot <id> [options]        (node src/oracle/main.js once ...)

Produces one sensor log of SIM_LOG_SIZE readings for one lot immediately. The readings are
SIM_SAMPLE_SECONDS apart and end just before the chain's latest block time. The log is
uploaded to IPFS and anchored with anchorSensorLog, or sent with reportExcursion when the
excursion rule triggers (scenarios "excursion" and "freeze" trigger it within one log of the
default size).

Options
  --lot <id>          the lot to log (required)
  --scenario <name>   normal (default), excursion, freeze or spike
  --json              print the result as one JSON object on stdout; progress goes to stderr
  --help              show this text

Scenarios
${SCENARIO_LIST}

Exit status: 0 when the log was anchored or the excursion reported; 1 when it was not
(inactive or unknown lot, failed upload or transaction) or for a configuration or pre-flight
error; 2 for a wrong command line.

${ENVIRONMENT_NOTE}`;

export const CHECK_USAGE = `Usage: npm run oracle:check        (node src/oracle/main.js check [--json])

Runs the pre-flight checks and prints what the oracle would use: network, chain id, registry
address, signer and number of lots. Sends no transaction.

Exit status: 0 when every check passes; 1 with an explanation when one fails.`;

/**
 * @typedef {object} OracleCliIo
 * @property {Record<string, string|undefined>} [env]  environment to configure from (default process.env)
 * @property {(line: string) => void} [out]            writes a result line (default stdout)
 * @property {(line: string) => void} [err]            writes a diagnostic line (default stderr)
 * @property {AbortSignal} [signal]                    aborting it stops "monitor" cleanly
 * @property {() => number} [clock]                    current time in Unix seconds
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 * @property {(options: { config: import("../config.js").OracleConfig }) => Promise<object>} [connect]
 *           builds the registry client; tests pass a function that returns a fake
 */

/**
 * Run one oracle command.
 * @param {string[]} argv the arguments after the program name, for example ["once", "--lot", "2"]
 * @param {OracleCliIo} [io]
 * @returns {Promise<number>} the exit code
 */
export async function runOracleCli(argv, io = {}) {
  const context = {
    env: io.env ?? process.env,
    out: io.out ?? ((line) => process.stdout.write(`${line}\n`)),
    err: io.err ?? ((line) => process.stderr.write(`${line}\n`)),
    signal: io.signal,
    clock: io.clock ?? systemClock,
    sleep: io.sleep ?? abortableSleep,
    connect: io.connect ?? ((options) => connectRegistry(options)),
  };
  const [command, ...rest] = argv;
  const usage = { monitor: MONITOR_USAGE, once: ONCE_USAGE, check: CHECK_USAGE }[command] ?? ORACLE_USAGE;
  try {
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      context.out(ORACLE_USAGE);
      return command === undefined ? 2 : 0;
    }
    const handler = COMMANDS[command];
    if (handler === undefined) {
      throw new UsageError(`Unknown command "${command}".`);
    }
    if (rest.includes("--help") || rest.includes("-h")) {
      context.out(usage);
      return 0;
    }
    return await handler(rest, context);
  } catch (error) {
    if (error instanceof UsageError) {
      context.err(`error: ${error.message}\n\n${usage}`);
      return 2;
    }
    if (error instanceof OracleError) {
      // Configuration, deployment and pre-flight errors explain themselves; a stack trace would bury the instruction.
      context.err(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/** @type {Record<string, (args: string[], context: Required<Omit<OracleCliIo, "signal">> & { signal?: AbortSignal }) => Promise<number>>} */
const COMMANDS = {
  /** monitor: watch lots until the signal aborts or --cycles is reached. */
  async monitor(args, context) {
    const { values } = parse(args, { lots: { type: "string" }, scenario: { type: "string", multiple: true }, cycles: { type: "string" } });
    const lots = values.lots === undefined ? null : parseLotList(values.lots);
    const { defaultScenario, scenarios } = parseScenarios(values.scenario ?? []);
    const cycles = values.cycles === undefined ? null : parsePositiveInteger(values.cycles, "--cycles");

    return withOracle(context, { json: values.json }, async ({ config, runner }) => {
      await runner.monitor({
        lots,
        scenarios,
        defaultScenario,
        signal: context.signal,
        maxTicks: cycles === null ? Infinity : cycles * config.simulator.logSize,
      });
      return 0;
    });
  },

  /** once: one backfilled log for one lot. */
  async once(args, context) {
    const { values } = parse(args, { lot: { type: "string" }, scenario: { type: "string" } });
    if (values.lot === undefined) {
      throw new UsageError("--lot <id> is required: which lot should get a sensor log?");
    }
    const lotId = parsePositiveInteger(values.lot, "--lot");
    const scenario = values.scenario ?? "normal";
    assertScenario(scenario);

    // With --json, stdout carries exactly one object (the result), so a script can parse it; the
    // progress lines move to stderr.
    return withOracle(context, { json: false, eventsToStderr: values.json }, async ({ runner }) => {
      const result = await runner.runOnce({ lotId, scenario, signal: context.signal });
      if (values.json) {
        const { error, ...rest } = result;
        context.out(JSON.stringify(error === undefined ? rest : { ...rest, error: error.message }));
      }
      return result.outcome === "anchored" || result.outcome === "excursion" ? 0 : 1;
    });
  },

  /** check: the pre-flight checks only. */
  async check(args, context) {
    const { values } = parse(args, {});
    return withOracle(context, { json: values.json }, async () => 0);
  },
};

/**
 * Load the configuration, connect to storage and to the registry (which runs
 * the pre-flight checks), print the READY line, run `body`, and always close
 * the registry connection.
 *
 * @param {object} context the CLI context
 * @param {{ json?: boolean, eventsToStderr?: boolean }} output how events are printed
 * @param {(tools: { config: import("../config.js").OracleConfig, runner: ReturnType<typeof createOracleRunner> }) => Promise<number>} body
 * @returns {Promise<number>} the exit code
 */
async function withOracle(context, { json = false, eventsToStderr = false }, body) {
  const config = loadConfig(context.env);
  const storage = createStorage(config);
  const documents = createDocuments({ schemasDir: config.paths.schemasDir });

  const print = (event) => {
    const line = json ? formatEventJson(event) : formatEvent(event);
    (eventsToStderr || isDiagnostic(event) ? context.err : context.out)(line);
  };

  const registry = await context.connect({ config });
  try {
    print({ at: context.clock(), event: "ready", ...registry.info, storage: storage.name });
    for (const note of registry.info?.warnings ?? []) {
      print({ at: context.clock(), event: "warning", note });
    }
    const runner = createOracleRunner({
      registry,
      storage,
      documents,
      settings: { ...config.simulator, ...config.excursion },
      clock: context.clock,
      sleep: context.sleep,
      emit: print,
    });
    return await body({ config, runner });
  } finally {
    await registry.close?.();
  }
}

/**
 * Parse the options of one command. Unknown options and positional arguments are usage errors.
 * @param {string[]} args
 * @param {import("node:util").ParseArgsConfig["options"]} options command-specific options; --json is always accepted
 * @returns {{ values: Record<string, any> }}
 */
function parse(args, options) {
  try {
    return parseArgs({ args, options: { ...options, json: { type: "boolean" } }, allowPositionals: false, strict: true });
  } catch (error) {
    throw new UsageError(error.message);
  }
}

/**
 * Parse a positive whole number given as an option value.
 * @param {string} text
 * @param {string} option option name, for the message
 * @returns {number}
 */
function parsePositiveInteger(text, option) {
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UsageError(`${option} must be a whole number of at least 1 (got "${text}").`);
  }
  return value;
}

/**
 * Parse "--lots 1,2,3".
 * @param {string} text
 * @returns {number[]} distinct lot ids in the order given
 */
function parseLotList(text) {
  const ids = text.split(",").map((part) => part.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new UsageError("--lots needs at least one lot id, e.g. --lots 1,3.");
  }
  return [...new Set(ids.map((part) => parsePositiveInteger(part, "--lots")))];
}

/**
 * Reject an unknown scenario name as a usage error.
 * @param {string} name
 */
function assertScenario(name) {
  if (!SCENARIO_NAMES.includes(name)) {
    throw new UsageError(`Unknown scenario "${name}". Scenarios: ${SCENARIO_NAMES.join(", ")}.`);
  }
}

/**
 * Parse the repeated --scenario option of "monitor": a bare name sets the
 * default, "<lot>=<name>" sets one lot.
 * @param {string[]} entries
 * @returns {{ defaultScenario: string, scenarios: Record<number, string> }}
 */
function parseScenarios(entries) {
  let defaultScenario = null;
  const scenarios = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      assertScenario(entry);
      if (defaultScenario !== null && defaultScenario !== entry) {
        throw new UsageError(`--scenario names two defaults ("${defaultScenario}" and "${entry}"). Use <lot>=<name> to give one lot its own scenario.`);
      }
      defaultScenario = entry;
    } else {
      const name = entry.slice(separator + 1);
      assertScenario(name);
      scenarios[parsePositiveInteger(entry.slice(0, separator), "--scenario <lot>=<name>")] = name;
    }
  }
  return { defaultScenario: defaultScenario ?? "normal", scenarios };
}
