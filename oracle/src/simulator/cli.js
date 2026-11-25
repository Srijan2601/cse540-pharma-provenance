/**
 * "npm run simulate": prints the readings of a scenario and what the
 * excursion rule makes of them, WITHOUT touching the chain or IPFS.
 *
 * It exists to make the simulator and the rule inspectable: the same seed,
 * lot and scenario print the same temperatures every time, so the output can
 * be compared with the sensor log the oracle anchors, pasted into the
 * documentation, or used to try a different range or K before a demo.
 *
 * The logic is here, separate from the executable (main.js), so tests can
 * call it with captured output and a fixed clock.
 */

import { parseArgs } from "node:util";

import { loadConfig } from "../config.js";
import { OracleError, UsageError } from "../errors.js";
import { evaluateRule, isOutOfRange } from "../oracle/rule.js";
import { formatRange, formatTenths, isoTime } from "../units.js";
import { SCENARIO_NAMES, SCENARIOS } from "./scenarios.js";
import { createReadingSource } from "./source.js";

/** The range used when none is given: 2.0 C to 8.0 C, the usual range of a refrigerated medicine. */
const DEFAULT_RANGE = Object.freeze({ minTenthsC: 20, maxTenthsC: 80 });

export const SIMULATE_USAGE = `Usage: npm run simulate -- [options]        (node src/simulator/main.js [options])

Prints simulated temperature readings for one lot and evaluates the excursion rule on them.
Nothing is uploaded and no transaction is sent.

Options
  --scenario <name>   which scenario to print (default: normal)
${SCENARIO_NAMES.map((name) => `                        ${name.padEnd(10)} ${SCENARIOS[name].summary}`).join("\n")}
  --min <tenths>      lower limit of the lot's range in tenths of a degree C (default 20 = 2.0 C)
  --max <tenths>      upper limit (default 80 = 8.0 C); a frozen product is e.g. --min -250 --max -150
  --count <n>         number of readings (default: SIM_LOG_SIZE)
  --lot <id>          lot id; every lot has its own random stream (default 1)
  --index <n>         index of the first reading in the lot's series (default 0)
  --end <unix time>   the readings end just before this time (default: now)
  --json              print one JSON object instead of the table
  --help              show this text

Environment: SIM_SEED (default 540), SIM_SAMPLE_SECONDS (default 60), SIM_LOG_SIZE (default 12),
EXCURSION_RUN_LENGTH (default 3). The same seed, lot, scenario and index always give the same temperatures.`;

/**
 * @typedef {object} SimulateCliIo
 * @property {Record<string, string|undefined>} [env]  environment to configure from (default process.env)
 * @property {(line: string) => void} [out]            writes a line of output (default stdout)
 * @property {(line: string) => void} [err]            writes a line of diagnostics (default stderr)
 * @property {() => number} [clock]                    current time in Unix seconds, used when --end is not given
 */

/**
 * Run the simulate command.
 * @param {string[]} argv the arguments after the program name
 * @param {SimulateCliIo} [io]
 * @returns {Promise<number>} exit code: 0 printed, 1 invalid configuration or impossible scenario, 2 wrong usage
 */
export async function runSimulateCli(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
  const clock = io.clock ?? (() => Math.floor(Date.now() / 1000));
  try {
    const values = parseOptions(argv);
    if (values.help) {
      out(SIMULATE_USAGE);
      return 0;
    }
    const config = loadConfig(env);
    const scenario = values.scenario ?? "normal";
    if (!SCENARIO_NAMES.includes(scenario)) {
      throw new UsageError(`Unknown scenario "${scenario}". Scenarios: ${SCENARIO_NAMES.join(", ")}.`);
    }
    const range = {
      minTenthsC: integerOption(values.min, "--min", DEFAULT_RANGE.minTenthsC, -32768, 32767),
      maxTenthsC: integerOption(values.max, "--max", DEFAULT_RANGE.maxTenthsC, -32768, 32767),
    };
    if (range.minTenthsC >= range.maxTenthsC) {
      throw new UsageError(`--min (${range.minTenthsC}) must be lower than --max (${range.maxTenthsC}).`);
    }
    const count = integerOption(values.count, "--count", config.simulator.logSize, 1, 100000);
    const lotId = integerOption(values.lot, "--lot", 1, 1, Number.MAX_SAFE_INTEGER);
    const startIndex = integerOption(values.index, "--index", 0, 0, Number.MAX_SAFE_INTEGER);
    const end = integerOption(values.end, "--end", clock(), 1, 253402300799);
    const { seed, sampleSeconds } = config.simulator;
    const { runLength } = config.excursion;

    const source = createReadingSource({ seed, lotId, range, scenario, sampleSeconds, startIndex });
    const readings = source.backfill(count, end);
    const evaluation = evaluateRule(readings, range, { runLength });

    if (values.json) {
      out(JSON.stringify({ scenario, lotId, seed, sampleSeconds, startIndex, range, runLength, readings, rule: evaluation }));
      return 0;
    }
    for (const line of renderTable({ scenario, lotId, seed, sampleSeconds, startIndex, range, runLength, readings, evaluation })) {
      out(line);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      err(`error: ${error.message}\n\n${SIMULATE_USAGE}`);
      return 2;
    }
    if (error instanceof OracleError) {
      err(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/**
 * Render the readings as a table with one line per reading.
 * @param {object} view
 * @returns {string[]} the lines
 */
function renderTable({ scenario, lotId, seed, sampleSeconds, startIndex, range, runLength, readings, evaluation }) {
  const lines = [
    `scenario ${scenario}   lot ${lotId}   range ${formatRange(range)}   seed ${seed}   ${readings.length} readings, ${sampleSeconds} s apart`,
    "    #  time (UTC)            temp",
  ];
  let run = 0;
  readings.forEach((reading, position) => {
    const out = isOutOfRange(reading.tenthsC, range);
    run = out ? run + 1 : 0;
    const marks = [];
    if (out) marks.push(`OUT OF RANGE (run ${run})`);
    if (evaluation.excursion?.index === position) marks.push(`<- rule triggers: ${evaluation.rule}`);
    const row = `${String(startIndex + position).padStart(5)}  ${isoTime(reading.t)}  ${formatTenths(reading.tenthsC).padStart(7)} C`;
    lines.push(marks.length > 0 ? `${row}  ${marks.join("  ")}` : row);
  });
  const temperatures = readings.map((reading) => reading.tenthsC);
  const verdict = evaluation.triggered
    ? `EXCURSION: the oracle would call reportExcursion with ${formatTenths(evaluation.excursion.tenthsC)} C observed at ${isoTime(evaluation.excursion.t)}`
    : `no excursion: the oracle would call anchorSensorLog (longest out-of-range run ${evaluation.longestRun}, the rule needs ${runLength})`;
  lines.push(
    `min ${formatTenths(Math.min(...temperatures))} C   max ${formatTenths(Math.max(...temperatures))} C   out of range ${evaluation.outOfRangeCount} of ${readings.length}`,
    verdict,
  );
  return lines;
}

/**
 * Parse the command line.
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
function parseOptions(argv) {
  const text = { type: "string" };
  try {
    return parseArgs({
      args: joinNegativeValues(argv),
      options: { scenario: text, min: text, max: text, count: text, lot: text, index: text, end: text, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    throw new UsageError(error.message);
  }
}

/**
 * Let a negative number follow an option after a space ("--min -250").
 * Node's argument parser would take "-250" for another option and demand
 * "--min=-250"; a temperature limit below zero is too common here for that.
 * @param {string[]} argv
 * @returns {string[]} the arguments with such pairs joined as "--option=-value"
 */
function joinNegativeValues(argv) {
  const joined = [];
  for (let i = 0; i < argv.length; i++) {
    if (/^--[a-z]+$/.test(argv[i]) && /^-\d/.test(argv[i + 1] ?? "")) {
      joined.push(`${argv[i]}=${argv[i + 1]}`);
      i += 1;
    } else {
      joined.push(argv[i]);
    }
  }
  return joined;
}

/**
 * Read a whole-number option.
 * @param {string|undefined} text the option value, or undefined when the option was not given
 * @param {string} option name, for the message
 * @param {number} fallback value when the option was not given
 * @param {number} min inclusive
 * @param {number} max inclusive
 * @returns {number}
 * @throws {UsageError}
 */
function integerOption(text, option, fallback, min, max) {
  if (text === undefined) return fallback;
  const value = /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new UsageError(`${option} must be a whole number from ${min} to ${max} (got "${text}").`);
  }
  return value;
}
