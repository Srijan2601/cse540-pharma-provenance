/**
 * The simulated cold chain: four scenarios, each a pure function
 *
 *   reading(seed, range, index, onset) -> temperature in tenths of a degree C
 *
 *   seed    32-bit seed of one sensor (the reading source derives it from SIM_SEED and the lot id)
 *   range   the lot's allowed range { minTenthsC, maxTenthsC }, both ends inclusive, as registered on-chain
 *   index   number of the reading, 0, 1, 2, ...
 *   onset   index at which the scenario's event starts (default 0); "normal" ignores it
 *
 * Nothing here keeps state, reads a clock or uses Math.random, so the same
 * arguments always give the same reading.
 *
 *   normal     stays inside the range: a slow drift around a setpoint plus small noise.
 *   excursion  a refrigeration failure: the temperature climbs past the maximum and stays there.
 *   freeze     the opposite failure: it falls below the minimum and stays there.
 *   spike      normal, except one isolated out-of-range reading every SPIKE_EVERY readings
 *              (a door opened briefly). With the default rule (3 consecutive readings) this
 *              must NOT be reported, which is the reason the rule exists.
 *
 * The shapes scale with the lot's range, so a frozen product (-25 C to -15 C)
 * and a refrigerated one (2 C to 8 C) both get plausible curves, and every
 * reading is an integer the contract's int16 can hold. A scenario that has to
 * leave the range on a side where int16 has no room left (for example an
 * "excursion" for a lot whose maximum is 3276.7 C) cannot be simulated and
 * throws SimulationError.
 *
 * No Node-only imports: this file also runs in the browser.
 */

import { SimulationError } from "../errors.js";
import { INT16_MAX, INT16_MIN, formatTenths, isInt16 } from "../units.js";
import { randomNoise, randomUnit } from "./prng.js";

/** Independent random streams of one sensor, so that for example the noise does not correlate with the drift phase. */
const STREAM = Object.freeze({ setpoint: 1, slowPhase: 2, fastPhase: 3, noise: 4, spike: 5 });

/**
 * Size of the in-range variation. Each part is a share of half the range
 * width, capped at a realistic absolute value in tenths of a degree, so a
 * very wide range does not produce a wildly swinging "normal" curve. The
 * three shares add up to 0.6, which leaves a margin to both limits.
 */
const SETPOINT_SHARE = 0.1;
const SETPOINT_CAP_TENTHS = 5;
const DRIFT_SHARE = 0.4;
const DRIFT_CAP_TENTHS = 12;
const NOISE_SHARE = 0.1;
const NOISE_CAP_TENTHS = 3;

/**
 * Periods of the two drift components, in readings. At the default of one
 * reading per minute, 90 readings is a typical compressor and defrost cycle;
 * the shorter, incommensurate period keeps the curve from repeating visibly.
 */
const SLOW_PERIOD_READINGS = 90;
const FAST_PERIOD_READINGS = 23;
const SLOW_WEIGHT = 0.65;
const FAST_WEIGHT = 0.35;

/** A failure starts this many readings after the onset; the readings before it are still normal. */
export const FAILURE_DELAY_READINGS = 2;
/** Time constant of the exponential approach to the failed-state temperature, in readings. */
const FAILURE_TIME_CONSTANT_READINGS = 3;
/**
 * From this many readings after the onset, every reading of "excursion" and
 * "freeze" is guaranteed to be out of range. With the default rule of 3
 * consecutive readings, the rule therefore triggers no later than the 9th
 * reading after the onset, inside the first log of the default size (12).
 */
export const FAILURE_OUT_OF_RANGE_FROM = 6;
/** How far beyond the limit a failed unit settles: a share of half the range width, within these bounds (tenths). */
const FAILURE_OVERSHOOT_SHARE = 0.6;
const FAILURE_OVERSHOOT_MIN_TENTHS = 15;
const FAILURE_OVERSHOOT_MAX_TENTHS = 40;

/** "spike": one out-of-range reading every SPIKE_EVERY readings, the first one SPIKE_FIRST readings after the onset. */
export const SPIKE_EVERY = 10;
export const SPIKE_FIRST = 6;
/** How far beyond the limit a spike reaches: a share of half the range width, within these bounds (tenths). */
const SPIKE_HEIGHT_SHARE = 0.5;
const SPIKE_HEIGHT_MIN_TENTHS = 10;
const SPIKE_HEIGHT_MAX_TENTHS = 30;

/**
 * @typedef {{ minTenthsC: number, maxTenthsC: number }} TemperatureRange
 *
 * @typedef {object} Scenario
 * @property {string} name      the value written to a sensor log's "scenario" field
 * @property {string} summary   one line for help texts
 * @property {(seed: number, range: TemperatureRange, index: number, onset?: number) => number} reading
 *           the pure function described at the top of this file
 */

/**
 * Check that a range is one the contract could have registered: two int16
 * values with min < max (the contract's InvalidTemperatureRange rule).
 *
 * @param {TemperatureRange} range
 * @returns {TemperatureRange} the same object
 * @throws {SimulationError}
 */
export function assertRange(range) {
  if (!range || !isInt16(range.minTenthsC) || !isInt16(range.maxTenthsC)) {
    throw new SimulationError(
      `A temperature range needs minTenthsC and maxTenthsC as whole numbers from ${INT16_MIN} to ${INT16_MAX} (tenths of a degree C).`,
    );
  }
  if (range.minTenthsC >= range.maxTenthsC) {
    throw new SimulationError(
      `The temperature range is empty or inverted: minimum ${formatTenths(range.minTenthsC)} C is not below maximum ${formatTenths(range.maxTenthsC)} C.`,
    );
  }
  return range;
}

/**
 * The quantities every scenario derives from a range.
 * @param {TemperatureRange} range a valid range
 * @returns {{ centre: number, half: number, roomAbove: number, roomBelow: number }}
 *          `roomAbove` / `roomBelow`: how many tenths int16 leaves beyond each limit
 */
function measure(range) {
  const half = (range.maxTenthsC - range.minTenthsC) / 2;
  return {
    centre: range.minTenthsC + half,
    half,
    roomAbove: INT16_MAX - range.maxTenthsC,
    roomBelow: range.minTenthsC - INT16_MIN,
  };
}

/**
 * The noise-free in-range temperature at one reading: a per-sensor setpoint
 * near the middle of the range plus two slow sine waves whose phases come
 * from the seed.
 *
 * @param {number} seed
 * @param {TemperatureRange} range
 * @param {number} index
 * @returns {number} a real number strictly inside the range
 */
function smoothTemperature(seed, range, index) {
  const { centre, half } = measure(range);
  const setpoint = Math.min(SETPOINT_CAP_TENTHS, half * SETPOINT_SHARE) * (2 * randomUnit(seed, STREAM.setpoint) - 1);
  const amplitude = Math.min(DRIFT_CAP_TENTHS, half * DRIFT_SHARE);
  const slow = Math.sin(2 * Math.PI * (index / SLOW_PERIOD_READINGS + randomUnit(seed, STREAM.slowPhase)));
  const fast = Math.sin(2 * Math.PI * (index / FAST_PERIOD_READINGS + randomUnit(seed, STREAM.fastPhase)));
  return centre + setpoint + amplitude * (SLOW_WEIGHT * slow + FAST_WEIGHT * fast);
}

/**
 * The measurement noise of one reading, in tenths of a degree (may be fractional).
 * @param {number} seed
 * @param {TemperatureRange} range
 * @param {number} index
 * @returns {number}
 */
function measurementNoise(seed, range, index) {
  return Math.min(NOISE_CAP_TENTHS, measure(range).half * NOISE_SHARE) * randomNoise(seed, STREAM.noise, index);
}

/**
 * Round to whole tenths and keep the value inside [low, high].
 * @param {number} value
 * @param {number} low
 * @param {number} high
 * @returns {number} an integer
 */
function roundWithin(value, low, high) {
  return Math.min(high, Math.max(low, Math.round(value)));
}

/**
 * Check the arguments shared by every scenario function.
 * @param {number} seed
 * @param {TemperatureRange} range
 * @param {number} index
 * @param {number} onset
 */
function assertArguments(seed, range, index, onset) {
  assertRange(range);
  for (const [name, value] of [["seed", seed], ["index", index], ["onset", onset]]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SimulationError(`The simulator's ${name} must be a non-negative whole number (got ${String(value)}).`);
    }
  }
}

/**
 * "normal": setpoint + drift + noise. The amplitudes sum to at most 0.6 of
 * half the range width, so the value is inside the range before rounding;
 * the final clamp only guards the rounding step in a range one tenth wide.
 * @type {Scenario["reading"]}
 */
function normalReading(seed, range, index, onset = 0) {
  assertArguments(seed, range, index, onset);
  return roundWithin(smoothTemperature(seed, range, index) + measurementNoise(seed, range, index), range.minTenthsC, range.maxTenthsC);
}

/**
 * Shared shape of "excursion" (direction +1) and "freeze" (direction -1):
 * normal until FAILURE_DELAY_READINGS after the onset, then an exponential
 * approach to a temperature beyond the limit, as a cold room does when its
 * unit stops (Newton's law of cooling, read in either direction).
 *
 * @param {1|-1} direction +1 leaves through the maximum, -1 through the minimum
 * @param {string} name scenario name, for the error message
 * @returns {Scenario["reading"]}
 */
function failureReading(direction, name) {
  return (seed, range, index, onset = 0) => {
    assertArguments(seed, range, index, onset);
    const { half, roomAbove, roomBelow } = measure(range);
    const limit = direction > 0 ? range.maxTenthsC : range.minTenthsC;
    const room = direction > 0 ? roomAbove : roomBelow;
    if (room < 1) {
      throw new SimulationError(
        `The "${name}" scenario needs a temperature ${direction > 0 ? "above the maximum" : "below the minimum"}, but ${formatTenths(limit)} C ` +
          "is the limit of the contract's int16, so no such reading exists for this lot.",
      );
    }
    const elapsed = index - onset;
    if (elapsed < FAILURE_DELAY_READINGS) {
      return normalReading(seed, range, index);
    }

    const overshoot = roundWithin(half * FAILURE_OVERSHOOT_SHARE, FAILURE_OVERSHOOT_MIN_TENTHS, FAILURE_OVERSHOOT_MAX_TENTHS);
    const settled = limit + direction * Math.min(room, overshoot);
    const start = smoothTemperature(seed, range, index);
    const progress = 1 - Math.exp(-(elapsed - FAILURE_DELAY_READINGS + 1) / FAILURE_TIME_CONSTANT_READINGS);
    let value = Math.round(start + (settled - start) * progress + measurementNoise(seed, range, index));

    // "and stays there": noise must not carry a late reading back inside the range, or a run of
    // out-of-range readings could be interrupted after the failure is well under way.
    if (elapsed >= FAILURE_OUT_OF_RANGE_FROM) {
      value = direction > 0 ? Math.max(value, limit + 1) : Math.min(value, limit - 1);
    }
    return roundWithin(value, INT16_MIN, INT16_MAX);
  };
}

/**
 * "spike": the normal curve with one reading beyond a limit every SPIKE_EVERY
 * readings. The readings on both sides of a spike are normal, so the longest
 * out-of-range run is exactly 1. It leaves through the maximum (a door left
 * open) unless int16 has no room there, in which case it leaves through the minimum.
 * @type {Scenario["reading"]}
 */
function spikeReading(seed, range, index, onset = 0) {
  assertArguments(seed, range, index, onset);
  const { half, roomAbove, roomBelow } = measure(range);
  if (roomAbove < 1 && roomBelow < 1) {
    throw new SimulationError('The "spike" scenario needs a temperature outside the range, but the range covers every value of the contract\'s int16.');
  }
  const elapsed = index - onset;
  if (elapsed < SPIKE_FIRST || (elapsed - SPIKE_FIRST) % SPIKE_EVERY !== 0) {
    return normalReading(seed, range, index);
  }
  const height = roundWithin(half * SPIKE_HEIGHT_SHARE, SPIKE_HEIGHT_MIN_TENTHS, SPIKE_HEIGHT_MAX_TENTHS);
  // A little variation so successive spikes are not identical; never less than one tenth beyond the limit.
  const reach = Math.max(1, height + Math.round(NOISE_CAP_TENTHS * randomNoise(seed, STREAM.spike, index)));
  return roomAbove >= 1 ? range.maxTenthsC + Math.min(roomAbove, reach) : range.minTenthsC - Math.min(roomBelow, reach);
}

/** The scenarios by name. The names are what a sensor log records in its "scenario" field. */
export const SCENARIOS = Object.freeze({
  normal: Object.freeze({
    name: "normal",
    summary: "stays inside the lot's range: slow drift around a setpoint plus small noise",
    reading: normalReading,
  }),
  excursion: Object.freeze({
    name: "excursion",
    summary: "refrigeration failure: warms past the maximum and stays there (the rule triggers)",
    reading: failureReading(1, "excursion"),
  }),
  freeze: Object.freeze({
    name: "freeze",
    summary: "drops below the minimum and stays there (the rule triggers)",
    reading: failureReading(-1, "freeze"),
  }),
  spike: Object.freeze({
    name: "spike",
    summary: `one isolated out-of-range reading every ${SPIKE_EVERY} readings, then recovery (the rule must NOT trigger)`,
    reading: spikeReading,
  }),
});

/** The scenario names, in the order they are documented. */
export const SCENARIO_NAMES = Object.freeze(Object.keys(SCENARIOS));

/**
 * Look a scenario up by name.
 * @param {string} name
 * @returns {Scenario}
 * @throws {SimulationError} for an unknown name
 */
export function getScenario(name) {
  if (typeof name !== "string" || !Object.hasOwn(SCENARIOS, name)) {
    throw new SimulationError(`Unknown scenario "${String(name)}". Scenarios: ${SCENARIO_NAMES.join(", ")}.`);
  }
  return SCENARIOS[name];
}

/**
 * One simulated reading: the pure function (scenario, seed, range, index) -> temperature.
 *
 * @param {string} scenario one of SCENARIO_NAMES
 * @param {number} seed
 * @param {TemperatureRange} range
 * @param {number} index
 * @param {number} [onset] reading index at which the scenario's event starts
 * @returns {number} integer tenths of a degree C within int16
 * @throws {SimulationError} unknown scenario, invalid arguments, or a scenario this range cannot host
 */
export function simulateReading(scenario, seed, range, index, onset = 0) {
  return getScenario(scenario).reading(seed, range, index, onset);
}

/**
 * Check, before any reading is produced, that a scenario can be simulated for
 * a range. The runner calls it when it starts to watch a lot, so an
 * impossible combination is reported once instead of at every reading.
 *
 * @param {string} scenario
 * @param {TemperatureRange} range
 * @returns {void}
 * @throws {SimulationError}
 */
export function assertScenarioFits(scenario, range) {
  // Every scenario checks its range before it looks at the index, so one reading is a complete check.
  getScenario(scenario).reading(0, assertRange(range), 0, 0);
}
