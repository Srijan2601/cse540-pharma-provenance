/**
 * A reading source: one simulated sensor attached to one lot. It turns the
 * pure scenario functions into timestamped readings { t, tenthsC }, the
 * shape a sensor-log document stores.
 *
 * Two clock modes:
 *
 *   live      take() returns ONE reading stamped with the injected clock at
 *             the moment it is taken. The monitor calls it once every
 *             SIM_SAMPLE_SECONDS, like polling a real data logger.
 *   backfill  backfill(count, now) returns `count` readings at once, spaced
 *             sampleSeconds apart and ending one second before `now`. It is
 *             used to produce a whole log instantly: the "once" command,
 *             `npm run simulate` and tests.
 *
 * Time is never read from a global here. The clock is a function handed in
 * by the caller, and backfill takes "now" as an argument, so a test controls
 * every timestamp.
 *
 * The source keeps two numbers of state: the index of the next reading and
 * the timestamp of the last one. Timestamps are strictly increasing over the
 * life of a source, which the sensor-log schema requires within a log and
 * which keeps successive logs of a lot from overlapping.
 *
 * No Node-only imports: this file also runs in the browser.
 */

import { SimulationError } from "../errors.js";
import { deriveSeed } from "./prng.js";
import { assertRange, assertScenarioFits, getScenario } from "./scenarios.js";

/**
 * @typedef {{ t: number, tenthsC: number }} Reading
 *   `t` in Unix seconds, `tenthsC` in tenths of a degree C: the units of the contract.
 *
 * @typedef {object} ReadingSource
 * @property {string} scenario        scenario name, for the sensor log's "scenario" field
 * @property {string} sensorId        identifier of the simulated sensor, for the sensor log's "sensorId" field
 * @property {number} nextIndex       index the next reading will have (read-only)
 * @property {() => Reading} take     live mode: one reading stamped with the clock
 * @property {(count: number, now: number) => Reading[]} backfill   backfill mode: `count` readings ending just before `now`
 */

/**
 * The seed of one lot's sensor. Every lot gets its own stream from the one
 * SIM_SEED, so two lots with the same range still show different curves.
 *
 * @param {number} seed  SIM_SEED
 * @param {number} lotId the lot's id in the registry
 * @returns {number} an unsigned 32-bit seed
 */
export function sensorSeed(seed, lotId) {
  return deriveSeed(seed, lotId);
}

/**
 * Create the simulated sensor of one lot.
 *
 * @param {object} options
 * @param {number} options.seed            SIM_SEED (0 to 2^32 - 1)
 * @param {number} options.lotId           the lot's id; part of the seed and of the sensor id
 * @param {import("./scenarios.js").TemperatureRange} options.range   the lot's registered range
 * @param {string} [options.scenario]      "normal" (default), "excursion", "freeze" or "spike"
 * @param {number} options.sampleSeconds   SIM_SAMPLE_SECONDS: spacing of backfilled readings
 * @param {() => number} [options.clock]   returns the current time in Unix seconds; required for take()
 * @param {number} [options.startIndex]    index of the first reading (default 0). A caller that continues an
 *                                         existing series passes the number of readings already produced.
 * @param {number} [options.onset]         index at which the scenario's event starts (default: startIndex,
 *                                         so a failure begins when this source begins)
 * @returns {ReadingSource}
 * @throws {SimulationError} for invalid options, or a scenario the range cannot host
 */
export function createReadingSource({ seed, lotId, range, scenario = "normal", sampleSeconds, clock, startIndex = 0, onset = startIndex }) {
  for (const [name, value, min] of [["seed", seed, 0], ["lotId", lotId, 1], ["sampleSeconds", sampleSeconds, 1], ["startIndex", startIndex, 0], ["onset", onset, 0]]) {
    if (!Number.isSafeInteger(value) || value < min) {
      throw new SimulationError(`A reading source needs ${name} as a whole number of at least ${min} (got ${String(value)}).`);
    }
  }
  const model = getScenario(scenario);
  assertScenarioFits(scenario, assertRange(range));
  // Copied and frozen: the readings must not change if the caller later modifies its range object.
  const lotRange = Object.freeze({ minTenthsC: range.minTenthsC, maxTenthsC: range.maxTenthsC });
  const lotSeed = sensorSeed(seed, lotId);

  let index = startIndex;
  let lastTime = 0;

  /**
   * Produce the next temperature and advance the index.
   * @returns {number}
   */
  function nextTemperature() {
    const tenthsC = model.reading(lotSeed, lotRange, index, onset);
    index += 1;
    return tenthsC;
  }

  return Object.freeze({
    scenario: model.name,
    sensorId: `sim-lot-${lotId}`,

    /** @returns {number} */
    get nextIndex() {
      return index;
    },

    /**
     * Live mode: take one reading now.
     * @returns {Reading}
     * @throws {SimulationError} when no clock was supplied or it does not return Unix seconds
     */
    take() {
      if (typeof clock !== "function") {
        throw new SimulationError("This reading source was created without a clock, so it can only backfill.");
      }
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 1) {
        throw new SimulationError(`The clock must return the time in whole Unix seconds (got ${String(now)}).`);
      }
      // Two readings never share a timestamp. A reading taken within the same second as the previous
      // one (a very short sample interval, or a clock that was set back) is stamped one second later.
      const t = Math.max(now, lastTime + 1);
      lastTime = t;
      return { t, tenthsC: nextTemperature() };
    },

    /**
     * Backfill mode: produce `count` readings instantly. The last one is stamped `now - 1`, the
     * others sampleSeconds apart before it, so every timestamp is strictly earlier than `now`.
     *
     * @param {number} count number of readings, at least 1
     * @param {number} now   Unix seconds; the oracle passes the chain's latest block time
     * @returns {Reading[]} in time order
     * @throws {SimulationError} when the window would start before time 1 or overlap readings already produced
     */
    backfill(count, now) {
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new SimulationError(`A backfill needs a whole number of readings, at least 1 (got ${String(count)}).`);
      }
      if (!Number.isSafeInteger(now)) {
        throw new SimulationError(`A backfill needs "now" in whole Unix seconds (got ${String(now)}).`);
      }
      const last = now - 1;
      const first = last - (count - 1) * sampleSeconds;
      if (first < 1) {
        throw new SimulationError(`A backfill of ${count} readings every ${sampleSeconds} s does not fit before time ${now}.`);
      }
      if (first <= lastTime) {
        throw new SimulationError(
          `A backfill of ${count} readings every ${sampleSeconds} s ending before ${now} would overlap the readings this source already produced (up to ${lastTime}).`,
        );
      }
      const readings = [];
      for (let i = 0; i < count; i++) {
        readings.push({ t: first + i * sampleSeconds, tenthsC: nextTemperature() });
      }
      lastTime = last;
      return readings;
    },
  });
}
