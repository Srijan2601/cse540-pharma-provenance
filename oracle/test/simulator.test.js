/**
 * Tests for the sensor simulator (src/simulator): the seeded
 * random numbers, the four scenarios as pure functions, the reading source
 * with its two clock modes, and the "simulate" command.
 *
 * The central properties:
 *   - determinism: the same seed gives the same readings, a different seed
 *     gives different ones, and nothing depends on Math.random or the clock;
 *   - shape: each scenario relates to the lot's range as documented, for
 *     refrigerated, frozen, ultra-cold and room-temperature ranges, for a
 *     range one tenth of a degree wide, and at the limits of int16;
 *   - units: every reading is an integer in the contract's int16 range.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { SimulationError } from "../src/errors.js";
import { evaluateRule, isOutOfRange } from "../src/oracle/rule.js";
import { SIMULATE_USAGE, runSimulateCli } from "../src/simulator/cli.js";
import { deriveSeed, hashWords, mix32, randomNoise, randomUnit } from "../src/simulator/prng.js";
import {
  FAILURE_DELAY_READINGS,
  FAILURE_OUT_OF_RANGE_FROM,
  SCENARIOS,
  SCENARIO_NAMES,
  SPIKE_EVERY,
  SPIKE_FIRST,
  assertRange,
  assertScenarioFits,
  getScenario,
  simulateReading,
} from "../src/simulator/scenarios.js";
import { createReadingSource, sensorSeed } from "../src/simulator/source.js";
import { INT16_MAX, INT16_MIN, formatRange, formatTenths, isInt16, isoTime } from "../src/units.js";

const MAIN = fileURLToPath(new URL("../src/simulator/main.js", import.meta.url));

/** Ranges a real lot could have, plus the awkward ones. Tenths of a degree C. */
const RANGES = {
  refrigerated: { minTenthsC: 20, maxTenthsC: 80 },
  frozen: { minTenthsC: -250, maxTenthsC: -150 },
  ultraCold: { minTenthsC: -800, maxTenthsC: -600 },
  roomTemperature: { minTenthsC: 150, maxTenthsC: 250 },
  acrossZero: { minTenthsC: -20, maxTenthsC: 20 },
  oneTenthWide: { minTenthsC: 20, maxTenthsC: 21 },
  oneTenthWideNegative: { minTenthsC: -1, maxTenthsC: 0 },
  nearTop: { minTenthsC: 32000, maxTenthsC: 32766 },
  nearBottom: { minTenthsC: -32767, maxTenthsC: -32000 },
};
const SEEDS = [0, 1, 540, 4294967295];
const SERIES_LENGTH = 400;

/** The first `count` readings of a scenario. */
function series(scenario, seed, range, count = SERIES_LENGTH, onset = 0) {
  return Array.from({ length: count }, (_, index) => simulateReading(scenario, seed, range, index, onset));
}

describe("seeded random numbers", () => {
  test("mix32 and hashWords return unsigned 32-bit integers and are deterministic", () => {
    for (const value of [0, 1, 2, 0xffffffff, 123456789]) {
      const mixed = mix32(value);
      assert.ok(Number.isInteger(mixed) && mixed >= 0 && mixed <= 0xffffffff);
      assert.equal(mix32(value), mixed);
    }
    assert.equal(hashWords(540, 1, 7), hashWords(540, 1, 7));
    assert.notEqual(hashWords(540, 1, 7), hashWords(540, 7, 1), "the order of the words matters");
    assert.notEqual(hashWords(540, 1), hashWords(540, 1, 0), "the number of words matters");
  });

  test("words above 32 bits are not truncated", () => {
    assert.notEqual(hashWords(1), hashWords(1 + 2 ** 32));
    assert.notEqual(hashWords(5, 2 ** 40), hashWords(5, 2 ** 41));
    assert.equal(hashWords(Number.MAX_SAFE_INTEGER), hashWords(Number.MAX_SAFE_INTEGER));
  });

  test("anything but a non-negative whole number is rejected", () => {
    for (const bad of [-1, 1.5, Number.NaN, Infinity, "7", null, undefined, 2 ** 53]) {
      assert.throws(() => hashWords(bad), TypeError, String(bad));
    }
  });

  test("randomUnit is in [0, 1), reproducible, and roughly uniform", () => {
    const draws = Array.from({ length: 20000 }, (_, index) => randomUnit(540, 4, index));
    assert.ok(draws.every((value) => value >= 0 && value < 1));
    assert.deepEqual(draws.slice(0, 50), Array.from({ length: 50 }, (_, index) => randomUnit(540, 4, index)));
    const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
    assert.ok(Math.abs(mean - 0.5) < 0.01, `mean ${mean}`);
    // Each tenth of the interval receives about a tenth of the draws.
    const buckets = new Array(10).fill(0);
    for (const value of draws) buckets[Math.floor(value * 10)] += 1;
    for (const count of buckets) assert.ok(count > 1800 && count < 2200, `bucket ${count}`);
    // No short cycle: almost all values are distinct.
    assert.ok(new Set(draws).size > 19990);
  });

  test("different seeds and different streams give unrelated sequences", () => {
    const sequence = (seed, stream) => Array.from({ length: 200 }, (_, index) => randomUnit(seed, stream, index));
    const matches = (a, b) => a.filter((value, index) => value === b[index]).length;
    assert.equal(matches(sequence(540, 4), sequence(541, 4)), 0);
    assert.equal(matches(sequence(540, 4), sequence(540, 5)), 0);
  });

  test("randomNoise is in [-1, 1), centred on zero, and concentrated near it", () => {
    const draws = Array.from({ length: 20000 }, (_, index) => randomNoise(7, 4, index));
    assert.ok(draws.every((value) => value >= -1 && value < 1));
    const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
    assert.ok(Math.abs(mean) < 0.02, `mean ${mean}`);
    // Triangular distribution: three quarters of the mass lies within half the range.
    const central = draws.filter((value) => Math.abs(value) < 0.5).length / draws.length;
    assert.ok(central > 0.72 && central < 0.78, `central share ${central}`);
  });

  test("deriveSeed gives every lot its own 32-bit seed", () => {
    const seeds = Array.from({ length: 1000 }, (_, index) => deriveSeed(540, index + 1));
    assert.ok(seeds.every((seed) => Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff));
    assert.equal(new Set(seeds).size, 1000);
    assert.equal(sensorSeed(540, 3), deriveSeed(540, 3));
  });

  test("the generation path does not use Math.random", () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error("Math.random must not be used by the simulator");
    };
    try {
      for (const scenario of SCENARIO_NAMES) {
        series(scenario, 540, RANGES.refrigerated, 50);
      }
      createReadingSource({ seed: 540, lotId: 1, range: RANGES.refrigerated, sampleSeconds: 60 }).backfill(12, 1_794_302_581);
    } finally {
      Math.random = original;
    }
  });
});

describe("scenarios: determinism", () => {
  test("the same seed, range and index always give the same reading", () => {
    for (const scenario of SCENARIO_NAMES) {
      assert.deepEqual(series(scenario, 540, RANGES.refrigerated), series(scenario, 540, RANGES.refrigerated), scenario);
    }
  });

  test("a reading depends only on its own index: any order of evaluation gives the same values", () => {
    for (const scenario of SCENARIO_NAMES) {
      const forwards = series(scenario, 99, RANGES.frozen, 60);
      const backwards = Array.from({ length: 60 }, (_, i) => simulateReading(scenario, 99, RANGES.frozen, 59 - i)).reverse();
      assert.deepEqual(backwards, forwards, scenario);
    }
  });

  test("different seeds give different series", () => {
    for (const scenario of SCENARIO_NAMES) {
      assert.notDeepEqual(series(scenario, 540, RANGES.refrigerated), series(scenario, 541, RANGES.refrigerated), scenario);
    }
  });

  test("known values for the default seed (a change of the generator must be deliberate)", () => {
    const source = createReadingSource({ seed: 540, lotId: 1, range: RANGES.refrigerated, scenario: "excursion", sampleSeconds: 60 });
    assert.deepEqual(
      source.backfill(12, 1_794_302_581).map((reading) => reading.tenthsC),
      [39, 40, 57, 70, 78, 84, 86, 91, 94, 95, 96, 98],
    );
  });
});

describe("scenarios: shape against the lot's range", () => {
  for (const [label, range] of Object.entries(RANGES)) {
    test(`normal stays inside ${label} (${formatRange(range)}) and is an int16 integer`, () => {
      for (const seed of SEEDS) {
        const readings = series("normal", seed, range);
        for (const tenthsC of readings) {
          assert.ok(isInt16(tenthsC), `${tenthsC} is not an int16 integer`);
          assert.ok(!isOutOfRange(tenthsC, range), `${tenthsC} is outside ${formatRange(range)} (seed ${seed})`);
        }
      }
    });
  }

  test("normal drifts slowly: it varies, but never jumps by more than a degree between readings", () => {
    for (const seed of SEEDS) {
      const readings = series("normal", seed, RANGES.refrigerated);
      assert.ok(new Set(readings).size >= 10, "the curve should not be flat");
      for (let i = 1; i < readings.length; i++) {
        assert.ok(Math.abs(readings[i] - readings[i - 1]) <= 10, `jump of ${readings[i] - readings[i - 1]} tenths at ${i}`);
      }
      // It uses the middle of the range, leaving a margin to both limits.
      assert.ok(Math.min(...readings) >= 30 && Math.max(...readings) <= 70, `${Math.min(...readings)}..${Math.max(...readings)}`);
    }
  });

  test("a very wide range does not make the normal curve swing wildly", () => {
    const wide = { minTenthsC: -10000, maxTenthsC: 10000 };
    const readings = series("normal", 540, wide);
    assert.ok(Math.max(...readings) - Math.min(...readings) <= 50, "variation is capped at a few degrees");
  });

  for (const [label, range] of Object.entries(RANGES)) {
    const hasRoomAbove = range.maxTenthsC < INT16_MAX;
    const hasRoomBelow = range.minTenthsC > INT16_MIN;

    test(`excursion warms past the maximum of ${label} and stays there`, { skip: !hasRoomAbove }, () => {
      for (const seed of SEEDS) {
        const readings = series("excursion", seed, range);
        assert.ok(readings.every(isInt16));
        // Before the failure starts, the lot is fine.
        for (const tenthsC of readings.slice(0, FAILURE_DELAY_READINGS)) assert.ok(!isOutOfRange(tenthsC, range));
        // From the guaranteed point on, every reading is above the maximum: no dip back inside.
        for (const tenthsC of readings.slice(FAILURE_OUT_OF_RANGE_FROM)) assert.ok(tenthsC > range.maxTenthsC, `${tenthsC} <= ${range.maxTenthsC}`);
        // It leaves through the maximum only.
        assert.ok(readings.every((tenthsC) => tenthsC >= range.minTenthsC));
      }
    });

    test(`freeze drops below the minimum of ${label} and stays there`, { skip: !hasRoomBelow }, () => {
      for (const seed of SEEDS) {
        const readings = series("freeze", seed, range);
        assert.ok(readings.every(isInt16));
        for (const tenthsC of readings.slice(0, FAILURE_DELAY_READINGS)) assert.ok(!isOutOfRange(tenthsC, range));
        for (const tenthsC of readings.slice(FAILURE_OUT_OF_RANGE_FROM)) assert.ok(tenthsC < range.minTenthsC, `${tenthsC} >= ${range.minTenthsC}`);
        assert.ok(readings.every((tenthsC) => tenthsC <= range.maxTenthsC));
      }
    });

    test(`spike has isolated out-of-range readings in ${label}, each followed by recovery`, () => {
      for (const seed of SEEDS) {
        const readings = series("spike", seed, range);
        assert.ok(readings.every(isInt16));
        const out = readings.map((tenthsC) => isOutOfRange(tenthsC, range));
        const expected = readings.map((_, index) => index >= SPIKE_FIRST && (index - SPIKE_FIRST) % SPIKE_EVERY === 0);
        assert.deepEqual(out, expected, "exactly the scheduled readings are out of range");
        for (let i = 1; i < out.length; i++) assert.ok(!(out[i] && out[i - 1]), "two spikes are never adjacent");
        // Everything that is not a spike is the normal curve.
        const normal = series("normal", seed, range);
        readings.forEach((tenthsC, index) => {
          if (!out[index]) assert.equal(tenthsC, normal[index]);
        });
      }
    });
  }

  test("a failure settles a plausible distance beyond the limit and keeps a little noise", () => {
    const tail = series("excursion", 540, RANGES.refrigerated, 200).slice(40);
    assert.ok(Math.min(...tail) >= 90 && Math.max(...tail) <= 105, `${Math.min(...tail)}..${Math.max(...tail)}`);
    assert.ok(new Set(tail).size > 1, "the settled temperature should not be a flat line");
    const frozenTail = series("freeze", 540, RANGES.frozen, 200).slice(40);
    assert.ok(Math.max(...frozenTail) <= -260 && Math.min(...frozenTail) >= -290, `${Math.min(...frozenTail)}..${Math.max(...frozenTail)}`);
  });

  test("the warm-up rises steadily from the normal level to beyond the limit", () => {
    const readings = series("excursion", 540, RANGES.refrigerated, 12);
    // Not a jump: it takes at least two readings after the failure starts to cross 8.0 C.
    assert.ok(!isOutOfRange(readings[FAILURE_DELAY_READINGS], RANGES.refrigerated));
    assert.ok(readings[11] > readings[FAILURE_DELAY_READINGS]);
  });

  test("the onset moves the event without changing the readings before it", () => {
    const onset = 30;
    const normal = series("normal", 540, RANGES.refrigerated, 80);
    for (const scenario of ["excursion", "freeze", "spike"]) {
      const shifted = series(scenario, 540, RANGES.refrigerated, 80, onset);
      assert.deepEqual(shifted.slice(0, onset), normal.slice(0, onset), `${scenario}: readings before the onset are normal`);
      const firstOut = shifted.findIndex((tenthsC) => isOutOfRange(tenthsC, RANGES.refrigerated));
      assert.ok(firstOut >= onset + FAILURE_DELAY_READINGS, `${scenario}: first out-of-range reading at ${firstOut}`);
    }
    assert.deepEqual(series("normal", 540, RANGES.refrigerated, 80, onset), normal, "normal ignores the onset");
  });

  test("with the default rule, excursion and freeze trigger within the first log; normal and spike never do", () => {
    for (const range of [RANGES.refrigerated, RANGES.frozen, RANGES.ultraCold, RANGES.roomTemperature, RANGES.oneTenthWide]) {
      for (const seed of SEEDS) {
        const evaluate = (scenario, count) =>
          evaluateRule(series(scenario, seed, range, count).map((tenthsC, index) => ({ t: 1000 + index, tenthsC })), range, { runLength: 3 });
        for (const scenario of ["excursion", "freeze"]) {
          const result = evaluate(scenario, 12);
          assert.ok(result.triggered, `${scenario} must trigger`);
          assert.ok(result.excursion.index <= FAILURE_OUT_OF_RANGE_FROM + 2, `${scenario} triggered at ${result.excursion.index}`);
        }
        assert.equal(evaluate("normal", SERIES_LENGTH).triggered, false);
        const spike = evaluate("spike", SERIES_LENGTH);
        assert.equal(spike.triggered, false);
        assert.equal(spike.longestRun, 1);
      }
    }
  });
});

describe("scenarios: the limits of int16", () => {
  const whole = { minTenthsC: INT16_MIN, maxTenthsC: INT16_MAX };
  const top = { minTenthsC: 32700, maxTenthsC: INT16_MAX };
  const bottom = { minTenthsC: INT16_MIN, maxTenthsC: -32700 };
  const topTwo = { minTenthsC: 32766, maxTenthsC: INT16_MAX };
  const bottomTwo = { minTenthsC: INT16_MIN, maxTenthsC: -32767 };

  test("normal works in every range, including the whole of int16 and its edges", () => {
    for (const range of [whole, top, bottom, topTwo, bottomTwo]) {
      for (const seed of SEEDS) {
        for (const tenthsC of series("normal", seed, range, 200)) {
          assert.ok(isInt16(tenthsC) && !isOutOfRange(tenthsC, range), `${tenthsC} in ${formatRange(range)}`);
        }
      }
    }
  });

  test("one tenth of room is enough: the excursion settles exactly at the int16 maximum", () => {
    const range = { minTenthsC: 32000, maxTenthsC: INT16_MAX - 1 };
    const readings = series("excursion", 540, range, 60);
    assert.ok(readings.every(isInt16));
    assert.ok(readings.slice(FAILURE_OUT_OF_RANGE_FROM).every((tenthsC) => tenthsC === INT16_MAX));
    const mirrored = { minTenthsC: INT16_MIN + 1, maxTenthsC: -32000 };
    assert.ok(series("freeze", 540, mirrored, 60).slice(FAILURE_OUT_OF_RANGE_FROM).every((tenthsC) => tenthsC === INT16_MIN));
  });

  test("a scenario that would need a value beyond int16 is refused with an explanation", () => {
    assert.throws(() => simulateReading("excursion", 540, top, 0), (error) => error instanceof SimulationError && /above the maximum.*int16/.test(error.message));
    assert.throws(() => simulateReading("freeze", 540, bottom, 0), (error) => error instanceof SimulationError && /below the minimum.*int16/.test(error.message));
    assert.throws(() => simulateReading("spike", 540, whole, 0), SimulationError);
    assert.throws(() => assertScenarioFits("excursion", whole), SimulationError);
    assert.throws(() => assertScenarioFits("freeze", whole), SimulationError);
    // The refusal does not depend on the index: the very first reading already says so.
    assert.throws(() => createReadingSource({ seed: 1, lotId: 1, range: top, scenario: "excursion", sampleSeconds: 60 }), SimulationError);
  });

  test("the possible direction still works at an edge", () => {
    assert.doesNotThrow(() => assertScenarioFits("freeze", top));
    assert.doesNotThrow(() => assertScenarioFits("excursion", bottom));
    assert.ok(series("freeze", 540, top, 30).slice(FAILURE_OUT_OF_RANGE_FROM).every((tenthsC) => tenthsC < top.minTenthsC && isInt16(tenthsC)));
    assert.ok(series("excursion", 540, bottom, 30).slice(FAILURE_OUT_OF_RANGE_FROM).every((tenthsC) => tenthsC > bottom.maxTenthsC && isInt16(tenthsC)));
  });

  test("a spike leaves through the minimum when there is no room above the maximum", () => {
    const readings = series("spike", 540, top, 40);
    const spikes = readings.filter((tenthsC) => isOutOfRange(tenthsC, top));
    assert.ok(spikes.length >= 3);
    assert.ok(spikes.every((tenthsC) => tenthsC < top.minTenthsC && isInt16(tenthsC)));
    const upward = series("spike", 540, bottom, 40).filter((tenthsC) => isOutOfRange(tenthsC, bottom));
    assert.ok(upward.every((tenthsC) => tenthsC > bottom.maxTenthsC));
  });
});

describe("scenarios: arguments", () => {
  test("the registry lists the four scenarios, each with a summary", () => {
    assert.deepEqual(SCENARIO_NAMES, ["normal", "excursion", "freeze", "spike"]);
    for (const name of SCENARIO_NAMES) {
      assert.equal(SCENARIOS[name].name, name);
      assert.ok(SCENARIOS[name].summary.length > 10);
      assert.equal(getScenario(name), SCENARIOS[name]);
      // The schema of the sensor log restricts the "scenario" field to lower-case kebab case.
      assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  test("an unknown scenario is refused and the message lists the known ones", () => {
    for (const bad of ["meltdown", "", "Normal", undefined, null, 3, "toString", "__proto__"]) {
      assert.throws(() => getScenario(bad), (error) => error instanceof SimulationError && /normal, excursion, freeze, spike/.test(error.message), String(bad));
    }
  });

  test("an invalid range is refused", () => {
    const bad = [
      { minTenthsC: 80, maxTenthsC: 20 },
      { minTenthsC: 50, maxTenthsC: 50 },
      { minTenthsC: 2.5, maxTenthsC: 80 },
      { minTenthsC: 20, maxTenthsC: 40000 },
      { minTenthsC: -40000, maxTenthsC: 20 },
      { minTenthsC: "20", maxTenthsC: 80 },
      { minTenthsC: 20 },
      null,
      undefined,
    ];
    for (const range of bad) {
      assert.throws(() => assertRange(range), SimulationError, JSON.stringify(range));
      assert.throws(() => simulateReading("normal", 1, range, 0), SimulationError);
    }
    assert.equal(assertRange(RANGES.refrigerated), RANGES.refrigerated);
  });

  test("seed, index and onset must be non-negative whole numbers", () => {
    for (const bad of [-1, 1.5, Number.NaN, "3", null]) {
      assert.throws(() => simulateReading("normal", bad, RANGES.refrigerated, 0), SimulationError);
      assert.throws(() => simulateReading("normal", 1, RANGES.refrigerated, bad), SimulationError);
      assert.throws(() => simulateReading("excursion", 1, RANGES.refrigerated, 0, bad), SimulationError);
    }
  });
});

describe("reading source: backfill mode", () => {
  const options = { seed: 540, lotId: 1, range: RANGES.refrigerated, sampleSeconds: 60 };

  test("N readings, evenly spaced, the last one just before 'now'", () => {
    const now = 1_794_302_581;
    const readings = createReadingSource(options).backfill(12, now);
    assert.equal(readings.length, 12);
    assert.equal(readings.at(-1).t, now - 1);
    assert.equal(readings[0].t, now - 1 - 11 * 60);
    for (let i = 1; i < readings.length; i++) assert.equal(readings[i].t - readings[i - 1].t, 60);
    assert.ok(readings.every((reading) => reading.t < now), "every timestamp is strictly earlier than now");
    // The shape a sensor-log document stores: exactly t and tenthsC.
    for (const reading of readings) assert.deepEqual(Object.keys(reading), ["t", "tenthsC"]);
  });

  test("the temperatures are the scenario's pure function of the lot's seed", () => {
    const readings = createReadingSource({ ...options, scenario: "spike" }).backfill(20, 1_794_302_581);
    const expected = Array.from({ length: 20 }, (_, index) => simulateReading("spike", sensorSeed(540, 1), RANGES.refrigerated, index));
    assert.deepEqual(readings.map((reading) => reading.tenthsC), expected);
  });

  test("the same seed gives the same log; another seed or another lot gives another", () => {
    const log = (overrides) => createReadingSource({ ...options, ...overrides }).backfill(48, 1_794_302_581);
    assert.deepEqual(log({}), log({}));
    assert.notDeepEqual(log({}).map((r) => r.tenthsC), log({ seed: 541 }).map((r) => r.tenthsC));
    assert.notDeepEqual(log({}).map((r) => r.tenthsC), log({ lotId: 2 }).map((r) => r.tenthsC));
  });

  test("the time does not influence the temperatures", () => {
    const a = createReadingSource(options).backfill(12, 1_794_302_581);
    const b = createReadingSource(options).backfill(12, 1_800_000_000);
    assert.deepEqual(a.map((r) => r.tenthsC), b.map((r) => r.tenthsC));
    assert.notDeepEqual(a.map((r) => r.t), b.map((r) => r.t));
  });

  test("startIndex continues the series, and the event starts where the source starts", () => {
    const whole = createReadingSource(options).backfill(24, 1_794_302_581).map((r) => r.tenthsC);
    const second = createReadingSource({ ...options, startIndex: 12 });
    assert.equal(second.nextIndex, 12);
    assert.deepEqual(second.backfill(12, 1_794_302_581).map((r) => r.tenthsC), whole.slice(12));
    assert.equal(second.nextIndex, 24);

    // An excursion source that starts at index 36 warms up during ITS first readings.
    const later = createReadingSource({ ...options, scenario: "excursion", startIndex: 36 }).backfill(12, 1_794_302_581).map((r) => r.tenthsC);
    assert.ok(!isOutOfRange(later[0], RANGES.refrigerated) && !isOutOfRange(later[1], RANGES.refrigerated));
    assert.ok(later.slice(FAILURE_OUT_OF_RANGE_FROM).every((tenthsC) => tenthsC > 80));
  });

  test("successive backfills must not overlap, and a window must fit before 'now'", () => {
    const source = createReadingSource(options);
    source.backfill(12, 1_794_302_581);
    assert.throws(() => source.backfill(12, 1_794_302_581), (error) => error instanceof SimulationError && /overlap/.test(error.message));
    assert.throws(() => source.backfill(12, 1_794_302_581 + 60 * 11), SimulationError);
    assert.equal(source.backfill(12, 1_794_302_581 + 60 * 12).length, 12, "the next window may start right after the previous one");
    assert.throws(() => createReadingSource(options).backfill(12, 600), (error) => error instanceof SimulationError && /does not fit/.test(error.message));
  });

  test("invalid arguments are refused", () => {
    const source = createReadingSource(options);
    for (const count of [0, -1, 1.5, "12", undefined]) assert.throws(() => source.backfill(count, 1_794_302_581), SimulationError);
    for (const now of [1.5, "now", undefined, Number.NaN]) assert.throws(() => source.backfill(12, now), SimulationError);
    for (const bad of [{ seed: -1 }, { lotId: 0 }, { sampleSeconds: 0 }, { startIndex: -1 }, { onset: 1.5 }, { scenario: "nope" }, { range: { minTenthsC: 5, maxTenthsC: 5 } }]) {
      assert.throws(() => createReadingSource({ ...options, ...bad }), SimulationError, JSON.stringify(bad));
    }
  });

  test("the source identifies the simulated sensor and its scenario for the document", () => {
    const source = createReadingSource({ ...options, lotId: 42, scenario: "freeze" });
    assert.equal(source.sensorId, "sim-lot-42");
    assert.equal(source.scenario, "freeze");
    assert.ok(Object.isFrozen(source));
  });

  test("the source keeps its own copy of the range", () => {
    const range = { minTenthsC: 20, maxTenthsC: 80 };
    const source = createReadingSource({ ...options, range });
    range.maxTenthsC = 21;
    const readings = source.backfill(100, 1_794_302_581).map((r) => r.tenthsC);
    assert.ok(Math.max(...readings) > 21, "later changes to the caller's object have no effect");
  });
});

describe("reading source: live mode", () => {
  test("each reading is stamped with the injected clock at the moment it is taken", () => {
    let now = 1_794_300_000;
    const source = createReadingSource({ seed: 540, lotId: 1, range: RANGES.refrigerated, sampleSeconds: 60, clock: () => now });
    const first = source.take();
    now += 60;
    const second = source.take();
    now += 61;
    const third = source.take();
    assert.deepEqual([first.t, second.t, third.t], [1_794_300_000, 1_794_300_060, 1_794_300_121]);
    assert.equal(source.nextIndex, 3);
  });

  test("live and backfill produce the same temperatures for the same indices", () => {
    let now = 1_794_300_000;
    const live = createReadingSource({ seed: 540, lotId: 3, range: RANGES.frozen, scenario: "freeze", sampleSeconds: 60, clock: () => (now += 60) });
    const taken = Array.from({ length: 15 }, () => live.take().tenthsC);
    const filled = createReadingSource({ seed: 540, lotId: 3, range: RANGES.frozen, scenario: "freeze", sampleSeconds: 60 }).backfill(15, 1_794_302_581);
    assert.deepEqual(taken, filled.map((r) => r.tenthsC));
  });

  test("two readings never share a timestamp, even if the clock stands still or goes back", () => {
    let now = 1_794_300_000;
    const source = createReadingSource({ seed: 1, lotId: 1, range: RANGES.refrigerated, sampleSeconds: 1, clock: () => now });
    const times = [source.take().t, source.take().t];
    now -= 100;
    times.push(source.take().t);
    now += 500;
    times.push(source.take().t);
    assert.deepEqual(times, [1_794_300_000, 1_794_300_001, 1_794_300_002, 1_794_300_400]);
  });

  test("take() needs a clock that returns whole Unix seconds", () => {
    const base = { seed: 1, lotId: 1, range: RANGES.refrigerated, sampleSeconds: 60 };
    assert.throws(() => createReadingSource(base).take(), (error) => error instanceof SimulationError && /without a clock/.test(error.message));
    for (const bad of [1794300000.5, 0, -5, "1794300000", undefined, 1_794_300_000_000_000_000]) {
      assert.throws(() => createReadingSource({ ...base, clock: () => bad }).take(), SimulationError, String(bad));
    }
  });
});

describe("units", () => {
  test("temperatures and times are formatted the same way everywhere", () => {
    assert.equal(formatTenths(54), "5.4");
    assert.equal(formatTenths(80), "8.0");
    assert.equal(formatTenths(-205), "-20.5");
    assert.equal(formatTenths(-5), "-0.5");
    assert.equal(formatTenths(0), "0.0");
    assert.equal(formatTenths(INT16_MAX), "3276.7");
    assert.equal(formatTenths(INT16_MIN), "-3276.8");
    assert.equal(formatRange({ minTenthsC: 20, maxTenthsC: 80 }), "2.0 C to 8.0 C");
    assert.equal(formatRange({ minTenthsC: -250, maxTenthsC: -150 }), "-25.0 C to -15.0 C");
    assert.equal(isoTime(1_794_302_580), "2026-11-10T09:23:00Z");
    assert.equal(isoTime(0), "1970-01-01T00:00:00Z");
  });

  test("isInt16 accepts exactly the contract's temperature type", () => {
    for (const good of [0, 1, -1, INT16_MIN, INT16_MAX]) assert.ok(isInt16(good));
    for (const bad of [INT16_MIN - 1, INT16_MAX + 1, 1.5, Number.NaN, "5", null, undefined, 5n]) assert.ok(!isInt16(bad), String(bad));
  });
});

describe("browser compatibility", () => {
  test("the pure modules import nothing that only exists in Node.js", async () => {
    // The verify page can reuse these files to re-evaluate a downloaded sensor log. Each may import
    // only from this list (and from errors.js, which is plain classes).
    const modules = ["units.js", "errors.js", "simulator/prng.js", "simulator/scenarios.js", "simulator/source.js", "oracle/rule.js"];
    const allowed = new Set(modules.map((file) => new URL(`../src/${file}`, import.meta.url).href));
    for (const file of modules) {
      const url = new URL(`../src/${file}`, import.meta.url);
      // Comments are removed first: JSDoc type annotations such as import("./x.js").Type are not code.
      const source = (await readFile(url, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const [, specifier] of source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)";/gms)) {
        assert.ok(specifier.startsWith("."), `${file} imports the package or built-in "${specifier}"`);
        assert.ok(allowed.has(new URL(specifier, url).href), `${file} imports ${specifier}, which is not in the browser-safe set`);
      }
      assert.ok(!/\bimport\s*\(/.test(source), `${file}: no dynamic imports`);
      assert.ok(!/\brequire\s*\(/.test(source), `${file}: no require calls`);
      assert.ok(!/\b(Buffer|process)\b\./.test(source), `${file}: no Node-only globals`);
    }
  });
});

describe("simulate command", () => {
  /** Run the command in-process with captured output. */
  async function simulate(args, env = {}) {
    const out = [];
    const err = [];
    const code = await runSimulateCli(args, { env, out: (line) => out.push(line), err: (line) => err.push(line), clock: () => 1_794_302_581 });
    return { code, out: out.join("\n"), err: err.join("\n"), lines: out };
  }

  test("prints one line per reading and what the rule decides, for every scenario", async () => {
    const normal = await simulate(["--scenario", "normal"]);
    assert.equal(normal.code, 0);
    assert.match(normal.lines[0], /^scenario normal {3}lot 1 {3}range 2\.0 C to 8\.0 C {3}seed 540 {3}12 readings, 60 s apart$/);
    assert.equal(normal.lines.length, 2 + 12 + 2);
    assert.match(normal.lines.at(-1), /^no excursion: the oracle would call anchorSensorLog \(longest out-of-range run 0, the rule needs 3\)$/);
    assert.match(normal.lines.at(-3), /^ {3}11 {2}2026-11-10T09:23:00Z {2} +\d\.\d C$/);

    const excursion = await simulate(["--scenario", "excursion"]);
    assert.match(excursion.out, /OUT OF RANGE \(run 3\) {2}<- rule triggers: 3 consecutive readings outside 2\.0 C to 8\.0 C/);
    assert.match(excursion.lines.at(-1), /^EXCURSION: the oracle would call reportExcursion with 9\.1 C observed at 2026-11-10T09:19:00Z$/);

    const freeze = await simulate(["--scenario", "freeze"]);
    assert.match(freeze.lines.at(-1), /^EXCURSION: the oracle would call reportExcursion with 0\.8 C/);

    const spike = await simulate(["--scenario", "spike"]);
    assert.equal(spike.out.match(/OUT OF RANGE/g).length, 1);
    assert.match(spike.lines.at(-1), /^no excursion: .*longest out-of-range run 1, the rule needs 3/);
  });

  test("the output is reproducible and follows SIM_SEED, SIM_LOG_SIZE, SIM_SAMPLE_SECONDS and EXCURSION_RUN_LENGTH", async () => {
    assert.equal((await simulate(["--scenario", "spike"])).out, (await simulate(["--scenario", "spike"])).out);
    assert.notEqual((await simulate([])).out, (await simulate([], { SIM_SEED: "7" })).out);

    const configured = await simulate(["--scenario", "spike", "--json"], { SIM_LOG_SIZE: "20", SIM_SAMPLE_SECONDS: "30", EXCURSION_RUN_LENGTH: "1" });
    const result = JSON.parse(configured.out);
    assert.equal(result.readings.length, 20);
    assert.equal(result.readings[1].t - result.readings[0].t, 30);
    assert.equal(result.runLength, 1);
    // K = 1 means a single out-of-range reading is an excursion, so even a spike triggers.
    assert.equal(result.rule.triggered, true);
    assert.equal(result.rule.rule, "1 reading outside 2.0 C to 8.0 C");
  });

  test("--json prints the readings and the rule evaluation as one object", async () => {
    const { code, out } = await simulate(["--scenario", "excursion", "--lot", "3", "--count", "10", "--index", "24", "--end", "1794400000", "--json"]);
    assert.equal(code, 0);
    const result = JSON.parse(out);
    assert.deepEqual(
      { scenario: result.scenario, lotId: result.lotId, seed: result.seed, startIndex: result.startIndex, range: result.range, count: result.readings.length },
      { scenario: "excursion", lotId: 3, seed: 540, startIndex: 24, range: { minTenthsC: 20, maxTenthsC: 80 }, count: 10 },
    );
    assert.equal(result.readings.at(-1).t, 1_794_399_999);
    assert.equal(result.rule.triggered, true);
    assert.deepEqual(result.readings[result.rule.excursion.index], { t: result.rule.excursion.t, tenthsC: result.rule.excursion.tenthsC });
  });

  test("a negative range can be given with a space or an equals sign", async () => {
    const spaced = await simulate(["--scenario", "freeze", "--min", "-250", "--max", "-150"]);
    const joined = await simulate(["--scenario", "freeze", "--min=-250", "--max=-150"]);
    assert.equal(spaced.code, 0);
    assert.equal(spaced.out, joined.out);
    assert.match(spaced.lines[0], /range -25\.0 C to -15\.0 C/);
    assert.match(spaced.lines.at(-1), /^EXCURSION: the oracle would call reportExcursion with -2\d\.\d C/);
  });

  test("--help prints the usage with every scenario and option", async () => {
    const { code, out } = await simulate(["--help"]);
    assert.equal(code, 0);
    assert.equal(out, SIMULATE_USAGE);
    for (const word of [...SCENARIO_NAMES, "--scenario", "--min", "--max", "--count", "--lot", "--index", "--end", "--json", "SIM_SEED"]) {
      assert.ok(out.includes(word), word);
    }
  });

  test("wrong usage exits with 2, an impossible request with 1", async () => {
    const cases = [
      [["--scenario", "meltdown"], /Unknown scenario "meltdown"/],
      [["--bogus"], /Unknown option '--bogus'/],
      [["extra"], /Unexpected argument/],
      [["--count", "0"], /--count must be a whole number from 1/],
      [["--count", "many"], /--count must be a whole number/],
      [["--min", "80", "--max", "20"], /--min \(80\) must be lower than --max \(20\)/],
      [["--max", "40000"], /--max must be a whole number from -32768 to 32767/],
      [["--lot", "0"], /--lot must be a whole number from 1/],
    ];
    for (const [args, pattern] of cases) {
      const result = await simulate(args);
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.err, pattern);
      assert.match(result.err, /Usage: npm run simulate/);
      assert.equal(result.out, "");
    }
    const impossible = await simulate(["--scenario", "excursion", "--min", "32000", "--max", "32767"]);
    assert.equal(impossible.code, 1);
    assert.match(impossible.err, /^error: The "excursion" scenario needs a temperature above the maximum/);
    const badConfig = await simulate([], { SIM_SEED: "minus one" });
    assert.equal(badConfig.code, 1);
    assert.match(badConfig.err, /^error: Invalid configuration:\n {2}- SIM_SEED/);
  });

  test("the executable prints the table and exits 0 (npm run simulate)", () => {
    const run = spawnSync(process.execPath, [MAIN, "--scenario", "excursion", "--end", "1794302581"], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^scenario excursion {3}lot 1/);
    assert.match(run.stdout, /EXCURSION: the oracle would call reportExcursion with 9\.1 C observed at 2026-11-10T09:19:00Z\n$/);
    const usage = spawnSync(process.execPath, [MAIN, "--scenario"], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /^error: /);
  });
});
