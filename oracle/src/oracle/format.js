/**
 * Console output of the oracle: one line per action.
 *
 * The runner emits plain event objects; this module turns each into either
 *   - a text line:   <time> <subject> <ACTION> key=value key="quoted value" ...
 *   - or, with --json, one JSON object per line.
 *
 * The text form is meant to be read during a demo and still be easy to
 * search: the action is a fixed upper-case word, every value has a name, and
 * a CID or transaction hash is printed in full so it can be copied into a
 * verifier or a block explorer. Temperatures are printed in degrees
 * (4.4C), times as ISO 8601 UTC.
 *
 * Nothing here can print a secret: events carry addresses, hashes, numbers
 * and error messages, and the registry client builds those messages without
 * the RPC URL or the key.
 */

import { formatTenths, isoTime } from "../units.js";

/** Events that describe a difficulty rather than a result. The command line sends them to stderr. */
const DIAGNOSTIC_EVENTS = new Set(["retry", "wait", "failure"]);

/** Width of the subject column ("lot 12", "oracle"). */
const SUBJECT_WIDTH = 7;
/** Width of the action column; "EXCURSION" is the longest action word. */
const ACTION_WIDTH = 9;

/**
 * Tell whether an event is a diagnostic (a retry, a wait or a failure).
 * @param {{ event: string }} event
 * @returns {boolean}
 */
export function isDiagnostic(event) {
  return DIAGNOSTIC_EVENTS.has(event.event);
}

/**
 * Format an event as one JSON line. The Unix time `at` is kept and an ISO `time` is added.
 * @param {{ at: number, event: string }} event
 * @returns {string}
 */
export function formatEventJson(event) {
  return JSON.stringify({ time: isoTime(event.at), ...event });
}

/**
 * Format an event as one text line.
 * @param {{ at: number, event: string } & Record<string, any>} event
 * @returns {string}
 */
export function formatEvent(event) {
  const [action, fields] = describe(event);
  const subject = typeof event.lotId === "number" ? `lot ${event.lotId}` : "oracle";
  const pairs = fields.filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => `${key}=${quote(value)}`);
  return `${isoTime(event.at)} ${subject.padEnd(SUBJECT_WIDTH)} ${action.padEnd(ACTION_WIDTH)} ${pairs.join(" ")}`.trimEnd();
}

/**
 * The action word and the ordered fields of an event.
 * @param {Record<string, any>} event
 * @returns {[string, [string, unknown][]]}
 */
function describe(event) {
  const celsius = (tenthsC) => (tenthsC === undefined ? undefined : `${formatTenths(tenthsC)}C`);
  switch (event.event) {
    case "ready":
      return [
        "READY",
        [
          ["network", event.network],
          ["chainId", event.chainId],
          ["registry", event.address],
          ["signer", event.signerAddress],
          ["via", event.signerSource],
          ["lots", event.totalLots],
          ["storage", event.storage],
        ],
      ];
    case "warning":
      return ["WARNING", [["note", event.note]]];
    case "start":
      return [
        "MONITOR",
        [
          ["lots", event.lots === null ? "all-active" : event.lots.join(",") || "none"],
          ["scenario", event.defaultScenario],
          ["sampleSeconds", event.sampleSeconds],
          ["logSize", event.logSize],
          ["runLength", event.runLength],
        ],
      ];
    case "watch":
      return [
        "WATCH",
        [
          ["status", event.status],
          ["range", `${formatTenths(event.range.minTenthsC)}..${formatTenths(event.range.maxTenthsC)}C`],
          ["scenario", event.scenario],
          ["logs", event.sensorLogCount],
        ],
      ];
    case "skip":
      return ["SKIP", [["status", event.status], ["reason", event.reason]]];
    case "unwatch":
      return ["UNWATCH", [["status", event.status], ["reason", event.reason], ["discarded", event.discarded || undefined]]];
    case "anchor":
      return [
        "ANCHOR",
        [
          ["log", event.logIndex],
          ["readings", event.readings],
          ["min", celsius(event.minTenthsC)],
          ["max", celsius(event.maxTenthsC)],
          // Shown only when something was out of range: it explains why no excursion was reported.
          ["outOfRange", event.outOfRange || undefined],
          ["longestRun", event.outOfRange ? `${event.longestRun}/${event.runLength}` : undefined],
          ["cid", event.cid],
          ["tx", event.txHash ?? "confirmed-by-reading-the-lot"],
          ["block", event.blockNumber],
        ],
      ];
    case "excursion":
      return [
        "EXCURSION",
        [
          ["log", event.logIndex],
          ["readings", event.readings],
          ["min", celsius(event.minTenthsC)],
          ["max", celsius(event.maxTenthsC)],
          ["reading", celsius(event.excursion.tenthsC)],
          ["observedAt", isoTime(event.excursion.t)],
          ["rule", event.excursion.rule],
          ["cid", event.cid],
          ["tx", event.txHash ?? "confirmed-by-reading-the-lot"],
          ["block", event.blockNumber],
          ["status", "Compromised"],
        ],
      ];
    case "wait":
      return [
        "WAIT",
        [
          ["readings", event.readings],
          ["chainTime", isoTime(event.chainTime)],
          ["newestReading", isoTime(event.newestReading)],
          ["note", "the chain's latest block is older than the newest reading; the log is closed once the chain's clock has caught up"],
        ],
      ];
    case "retry":
      return ["RETRY", [["step", event.step], ["attempt", `${event.attempt}/${event.attempts}`], ["delayMs", event.delayMs], ["error", event.error]]];
    case "failure":
      return [
        "FAILED",
        [
          ["step", event.step],
          ["error", event.error],
          ["readings", event.readings],
          // Says what happens to the readings: see closeLog in runner.js.
          ["readingsKept", event.readings === undefined ? undefined : !event.consumed],
        ],
      ];
    case "stop":
      return [
        "STOPPED",
        [
          ["reason", event.reason],
          ["ticks", event.ticks],
          ["anchored", event.anchored],
          ["excursions", event.excursions],
          ["failures", event.failures],
          ["discardedReadings", event.discarded],
        ],
      ];
    default:
      // An event type this formatter does not know is still printed, so nothing is lost silently.
      return [String(event.event).toUpperCase(), Object.entries(event).filter(([key]) => key !== "at" && key !== "event" && key !== "lotId")];
  }
}

/**
 * Write a value for a key=value pair. Text that contains a space, a quote or
 * an equals sign is JSON-quoted, so a line can always be split back into pairs.
 * @param {unknown} value
 * @returns {string}
 */
function quote(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return typeof value === "string" && /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}
