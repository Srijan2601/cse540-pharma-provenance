/**
 * The excursion rule: the off-chain half of design decision C7.
 *
 *   A lot has a temperature excursion when K consecutive readings are outside
 *   its registered range (K = EXCURSION_RUN_LENGTH, default 3).
 *
 * Division of work with the contract:
 *   - On-chain, reportExcursion checks ONE thing it can check cheaply and
 *     objectively: the reported reading is outside the range stored at
 *     registration (a reading equal to a bound is inside). It then marks the
 *     lot Compromised, which cannot be undone.
 *   - Off-chain, this rule decides WHEN a report is justified. Requiring a
 *     run of K readings filters out a single odd sample (a door opened for a
 *     moment, a sensor glitch), which would otherwise destroy a good lot.
 *     Keeping the run logic here means the chain stores no reading history
 *     and pays no gas per reading, and K can be tuned without a redeploy.
 *
 * What is reported: the reading that COMPLETES the run, that is the first
 * reading at which the run length reaches K. It is out of range by
 * definition, so the contract accepts it, and its timestamp becomes
 * observedAt.
 *
 * Runs do not stop at file boundaries. The oracle cuts the stream of
 * readings into logs, so a run may begin at the end of one log and complete
 * in the next. The caller therefore passes the run length the previous log
 * of the same lot ended with (`carriedRun`) and stores `runAtEnd` for the
 * next call. If a report could not be delivered, the carried run is already
 * K or more, and the next out-of-range reading triggers again; an in-range
 * reading resets the run to zero as usual.
 *
 * Everything here is a pure function of its arguments.
 *
 * No Node-only imports: this file also runs in the browser, so the verify
 * page can re-evaluate a downloaded log with the same code.
 */

import { formatRange } from "../units.js";

/**
 * @typedef {{ t: number, tenthsC: number }} Reading
 * @typedef {{ minTenthsC: number, maxTenthsC: number }} TemperatureRange
 *
 * @typedef {object} RuleEvaluation
 * @property {boolean} triggered        true when some reading completed a run of at least K
 * @property {{ t: number, tenthsC: number, index: number }|null} excursion
 *           the reading to report (the first one that completed a run) and its position in `readings`; null when not triggered
 * @property {string} rule              human-readable description for the sensor log's excursion.rule field
 * @property {number} runAtEnd          consecutive out-of-range readings at the end of the log; pass it as `carriedRun` next time
 * @property {number} longestRun        longest run seen, including readings carried in from the previous log
 * @property {number} outOfRangeCount   out-of-range readings in this log
 */

/**
 * Tell whether a reading violates a range, with the contract's comparison:
 * strictly below the minimum or strictly above the maximum. A reading equal
 * to either bound is in range (the contract reverts ReadingWithinRange for it).
 *
 * @param {number} tenthsC
 * @param {TemperatureRange} range
 * @returns {boolean}
 */
export function isOutOfRange(tenthsC, range) {
  return tenthsC < range.minTenthsC || tenthsC > range.maxTenthsC;
}

/**
 * Describe the rule in words, as recorded in a sensor log.
 *
 * @param {number} runLength K
 * @param {TemperatureRange} range
 * @param {{ startedEarlier?: boolean }} [options] `startedEarlier`: part of the run lies in the previous log
 *        of the lot, so a reader who counts only this file's readings finds fewer than K
 * @returns {string} for example "3 consecutive readings outside 2.0 C to 8.0 C"
 */
export function describeRule(runLength, range, { startedEarlier = false } = {}) {
  const what = runLength === 1 ? "1 reading" : `${runLength} consecutive readings`;
  return `${what} outside ${formatRange(range)}${startedEarlier ? " (the run began in the previous log)" : ""}`;
}

/**
 * Apply the rule to the readings of one log.
 *
 * @param {readonly Reading[]} readings in time order
 * @param {TemperatureRange} range the lot's registered range
 * @param {object} options
 * @param {number} options.runLength      K: consecutive out-of-range readings that trigger a report (at least 1)
 * @param {number} [options.carriedRun]   run length at the end of the lot's previous log (default 0)
 * @returns {RuleEvaluation}
 * @throws {TypeError} when runLength or carriedRun is not a whole number in its valid range
 */
export function evaluateRule(readings, range, { runLength, carriedRun = 0 }) {
  if (!Number.isSafeInteger(runLength) || runLength < 1) {
    throw new TypeError(`The excursion run length must be a whole number of at least 1 (got ${String(runLength)}).`);
  }
  if (!Number.isSafeInteger(carriedRun) || carriedRun < 0) {
    throw new TypeError(`The carried run length must be a non-negative whole number (got ${String(carriedRun)}).`);
  }

  let run = carriedRun;
  let longestRun = carriedRun;
  let outOfRangeCount = 0;
  let excursion = null;
  let startedEarlier = false;

  readings.forEach((reading, index) => {
    if (!isOutOfRange(reading.tenthsC, range)) {
      run = 0;
      return;
    }
    run += 1;
    outOfRangeCount += 1;
    longestRun = Math.max(longestRun, run);
    // Only the first completion counts: one excursion is reported per lot, and the readings that
    // follow it in the same log are context, not further reports.
    if (excursion === null && run >= runLength) {
      excursion = { t: reading.t, tenthsC: reading.tenthsC, index };
      // The run reaches back before this log when it is longer than the readings seen here so far.
      startedEarlier = run > index + 1;
    }
  });

  return {
    triggered: excursion !== null,
    excursion,
    rule: describeRule(runLength, range, { startedEarlier }),
    runAtEnd: run,
    longestRun,
    outOfRangeCount,
  };
}
