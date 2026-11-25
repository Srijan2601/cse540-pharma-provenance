/**
 * Tests for the excursion rule (src/oracle/rule.js): K
 * consecutive out-of-range readings trigger a report of the reading that
 * completed the run.
 *
 * The boundaries are what matter: K - 1 readings do not trigger and K do; a
 * reading exactly at the minimum or maximum is in range, as in the contract;
 * a run that straddles two log files is still a run; and an isolated spike
 * never triggers.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeRule, evaluateRule, isOutOfRange } from "../src/oracle/rule.js";
import { SCENARIO_NAMES, simulateReading } from "../src/simulator/scenarios.js";

const RANGE = { minTenthsC: 20, maxTenthsC: 80 };
const FROZEN = { minTenthsC: -250, maxTenthsC: -150 };
const IN = 50;
const HOT = 95;
const COLD = 5;

/** Turn temperatures into readings one minute apart. */
function readingsOf(temperatures, startTime = 1_794_300_000) {
  return temperatures.map((tenthsC, index) => ({ t: startTime + index * 60, tenthsC }));
}

/** Evaluate a list of temperatures with K = 3 unless stated otherwise. */
function evaluate(temperatures, { runLength = 3, carriedRun = 0, range = RANGE } = {}) {
  return evaluateRule(readingsOf(temperatures), range, { runLength, carriedRun });
}

describe("isOutOfRange", () => {
  test("a reading exactly at the minimum or the maximum is in range, as in the contract", () => {
    assert.equal(isOutOfRange(20, RANGE), false);
    assert.equal(isOutOfRange(80, RANGE), false);
    assert.equal(isOutOfRange(19, RANGE), true);
    assert.equal(isOutOfRange(81, RANGE), true);
    assert.equal(isOutOfRange(50, RANGE), false);
  });

  test("negative ranges and the int16 limits", () => {
    assert.equal(isOutOfRange(-250, FROZEN), false);
    assert.equal(isOutOfRange(-150, FROZEN), false);
    assert.equal(isOutOfRange(-251, FROZEN), true);
    assert.equal(isOutOfRange(-149, FROZEN), true);
    assert.equal(isOutOfRange(0, FROZEN), true);
    const whole = { minTenthsC: -32768, maxTenthsC: 32767 };
    assert.equal(isOutOfRange(-32768, whole), false);
    assert.equal(isOutOfRange(32767, whole), false);
  });
});

describe("the K-consecutive rule", () => {
  test("K - 1 consecutive out-of-range readings do not trigger", () => {
    const result = evaluate([IN, HOT, HOT, IN, IN]);
    assert.equal(result.triggered, false);
    assert.equal(result.excursion, null);
    assert.equal(result.longestRun, 2);
    assert.equal(result.outOfRangeCount, 2);
    assert.equal(result.runAtEnd, 0);
  });

  test("K consecutive out-of-range readings trigger, and the K-th is the one reported", () => {
    const readings = readingsOf([IN, HOT, 96, 97, IN]);
    const result = evaluateRule(readings, RANGE, { runLength: 3 });
    assert.equal(result.triggered, true);
    assert.deepEqual(result.excursion, { t: readings[3].t, tenthsC: 97, index: 3 });
    assert.equal(result.rule, "3 consecutive readings outside 2.0 C to 8.0 C");
    assert.equal(isOutOfRange(result.excursion.tenthsC, RANGE), true, "the reported reading is out of range by definition");
  });

  test("the same holds for every K from 1 to 10", () => {
    for (let k = 1; k <= 10; k++) {
      const short = evaluate([IN, ...new Array(k - 1).fill(HOT), IN], { runLength: k });
      assert.equal(short.triggered, false, `K=${k}: ${k - 1} readings must not trigger`);
      const exact = evaluate([IN, ...new Array(k).fill(HOT), IN], { runLength: k });
      assert.equal(exact.triggered, true, `K=${k}: ${k} readings must trigger`);
      assert.equal(exact.excursion.index, k, `K=${k}: the K-th out-of-range reading is reported`);
    }
  });

  test("readings exactly at the limits do not count towards a run, and interrupt one", () => {
    assert.equal(evaluate([80, 80, 80, 80]).triggered, false);
    assert.equal(evaluate([20, 20, 20, 20]).triggered, false);
    assert.equal(evaluate([81, 81, 80, 81, 81]).triggered, false, "a reading at the maximum resets the run");
    assert.equal(evaluate([19, 19, 20, 19, 19]).triggered, false, "a reading at the minimum resets the run");
    assert.equal(evaluate([81, 81, 81]).triggered, true);
    assert.equal(evaluate([19, 19, 19]).triggered, true);
  });

  test("an in-range reading resets the run", () => {
    const result = evaluate([HOT, HOT, IN, HOT, HOT, IN, HOT]);
    assert.equal(result.triggered, false);
    assert.equal(result.longestRun, 2);
    assert.equal(result.outOfRangeCount, 5);
    assert.equal(result.runAtEnd, 1);
  });

  test("too warm and too cold both count: the rule is about being outside the range", () => {
    const result = evaluate([HOT, COLD, HOT]);
    assert.equal(result.triggered, true);
    assert.equal(result.excursion.index, 2);
  });

  test("only the first completion is reported; later readings are context", () => {
    const result = evaluate([HOT, HOT, HOT, HOT, HOT, IN, HOT, HOT, HOT]);
    assert.equal(result.excursion.index, 2);
    assert.equal(result.longestRun, 5);
    assert.equal(result.runAtEnd, 3);
  });

  test("K = 1 reports the first out-of-range reading", () => {
    const result = evaluate([IN, IN, COLD, IN], { runLength: 1 });
    assert.equal(result.triggered, true);
    assert.equal(result.excursion.index, 2);
    assert.equal(result.rule, "1 reading outside 2.0 C to 8.0 C");
  });

  test("an empty log and an all-normal log do not trigger", () => {
    assert.deepEqual(evaluate([]), { triggered: false, excursion: null, rule: "3 consecutive readings outside 2.0 C to 8.0 C", runAtEnd: 0, longestRun: 0, outOfRangeCount: 0 });
    assert.equal(evaluate(new Array(50).fill(IN)).triggered, false);
  });

  test("it is a pure function: the readings are not modified and the result is repeatable", () => {
    const readings = Object.freeze(readingsOf([IN, HOT, HOT, HOT]).map(Object.freeze));
    const first = evaluateRule(readings, Object.freeze({ ...RANGE }), { runLength: 3 });
    const second = evaluateRule(readings, Object.freeze({ ...RANGE }), { runLength: 3 });
    assert.deepEqual(first, second);
  });

  test("works for a negative range", () => {
    const result = evaluate([-200, -140, -139, -138], { range: FROZEN });
    assert.equal(result.triggered, true);
    assert.equal(result.excursion.tenthsC, -138);
    assert.equal(result.rule, "3 consecutive readings outside -25.0 C to -15.0 C");
  });

  test("invalid K or carried run is a programming error", () => {
    for (const runLength of [0, -1, 1.5, "3", undefined, Number.NaN]) {
      assert.throws(() => evaluateRule([], RANGE, { runLength }), TypeError, String(runLength));
    }
    for (const carriedRun of [-1, 0.5, "2", Number.NaN]) {
      assert.throws(() => evaluateRule([], RANGE, { runLength: 3, carriedRun }), TypeError, String(carriedRun));
    }
  });
});

describe("runs across log boundaries", () => {
  test("a run that begins at the end of one log completes in the next", () => {
    const first = evaluate([IN, IN, HOT, HOT]);
    assert.equal(first.triggered, false);
    assert.equal(first.runAtEnd, 2);

    const second = evaluate([HOT, IN, IN], { carriedRun: first.runAtEnd });
    assert.equal(second.triggered, true);
    assert.equal(second.excursion.index, 0, "the first reading of the second log completes the run of 3");
    assert.equal(second.rule, "3 consecutive readings outside 2.0 C to 8.0 C (the run began in the previous log)");
  });

  test("without the carried run the same second log would not trigger", () => {
    assert.equal(evaluate([HOT, IN, IN]).triggered, false);
  });

  test("an in-range reading at the start of the next log cancels the carried run", () => {
    const second = evaluate([IN, HOT, HOT], { carriedRun: 2 });
    assert.equal(second.triggered, false);
    assert.equal(second.runAtEnd, 2);
  });

  test("K - 1 across the boundary does not trigger, K does", () => {
    assert.equal(evaluate([HOT, IN], { carriedRun: 1 }).triggered, false, "1 + 1 = 2 < 3");
    assert.equal(evaluate([HOT, HOT, IN], { carriedRun: 1 }).triggered, true, "1 + 2 = 3");
    assert.equal(evaluate([HOT, HOT, IN], { carriedRun: 1 }).excursion.index, 1);
  });

  test("a run can span more than two logs, so K may exceed the log size", () => {
    // K = 5 with logs of 2 readings: the run completes in the third log.
    let carriedRun = 0;
    const outcomes = [];
    for (const log of [[HOT, HOT], [HOT, HOT], [HOT, IN]]) {
      const result = evaluate(log, { runLength: 5, carriedRun });
      outcomes.push(result.triggered ? result.excursion.index : null);
      carriedRun = result.runAtEnd;
    }
    assert.deepEqual(outcomes, [null, null, 0]);
  });

  test("splitting a series into logs never changes which reading triggers", () => {
    const temperatures = Array.from({ length: 40 }, (_, index) => simulateReading("excursion", 540, RANGE, index, 17));
    const whole = evaluate(temperatures);
    assert.equal(whole.triggered, true);
    for (const logSize of [1, 2, 3, 5, 7, 12]) {
      let carriedRun = 0;
      let triggeredAt = null;
      for (let start = 0; start < temperatures.length && triggeredAt === null; start += logSize) {
        const result = evaluate(temperatures.slice(start, start + logSize), { carriedRun });
        if (result.triggered) triggeredAt = start + result.excursion.index;
        carriedRun = result.runAtEnd;
      }
      assert.equal(triggeredAt, whole.excursion.index, `log size ${logSize}`);
    }
  });

  test("the rule text says when part of the run lies in the previous log, and only then", () => {
    assert.match(evaluate([HOT], { carriedRun: 2 }).rule, /the run began in the previous log/);
    assert.match(evaluate([HOT, HOT], { carriedRun: 1 }).rule, /the run began in the previous log/);
    assert.doesNotMatch(evaluate([HOT, HOT, HOT], { carriedRun: 0 }).rule, /previous log/);
    // The carried run was interrupted, so the run that triggers lies entirely in this log.
    assert.doesNotMatch(evaluate([IN, HOT, HOT, HOT], { carriedRun: 2 }).rule, /previous log/);
    // The schema allows at most 200 characters for the rule text.
    assert.ok(describeRule(2000, { minTenthsC: -32768, maxTenthsC: 32767 }, { startedEarlier: true }).length <= 200);
  });

  test("after a report that could not be delivered, the next out-of-range reading triggers again", () => {
    // The previous log ended with a run of 4 (already past K = 3); its report failed.
    const next = evaluate([HOT, IN], { carriedRun: 4 });
    assert.equal(next.triggered, true);
    assert.equal(next.excursion.index, 0);
    // If the temperature has recovered in the meantime, nothing is reported.
    assert.equal(evaluate([IN, IN], { carriedRun: 4 }).triggered, false);
  });
});

describe("the rule and the simulator's scenarios", () => {
  test("the spike scenario never triggers for any K of at least 2, however the readings are cut into logs", () => {
    for (const seed of [0, 540, 99999]) {
      const temperatures = Array.from({ length: 300 }, (_, index) => simulateReading("spike", seed, RANGE, index));
      assert.ok(temperatures.some((tenthsC) => isOutOfRange(tenthsC, RANGE)), "the scenario does contain out-of-range readings");
      for (const runLength of [2, 3, 5]) {
        for (const logSize of [1, 4, 6, 7, 12, 300]) {
          let carriedRun = 0;
          for (let start = 0; start < temperatures.length; start += logSize) {
            const result = evaluate(temperatures.slice(start, start + logSize), { runLength, carriedRun });
            assert.equal(result.triggered, false, `seed ${seed}, K=${runLength}, log size ${logSize}, log starting at ${start}`);
            carriedRun = result.runAtEnd;
          }
        }
      }
    }
  });

  test("with K = 1 a spike does trigger: that is what K = 1 means", () => {
    const temperatures = Array.from({ length: 12 }, (_, index) => simulateReading("spike", 540, RANGE, index));
    assert.equal(evaluate(temperatures, { runLength: 1 }).triggered, true);
  });

  test("every scenario gives the documented verdict with the default settings (K = 3, 12 readings)", () => {
    const verdicts = Object.fromEntries(
      SCENARIO_NAMES.map((scenario) => [scenario, evaluate(Array.from({ length: 12 }, (_, index) => simulateReading(scenario, 540, RANGE, index))).triggered]),
    );
    assert.deepEqual(verdicts, { normal: false, excursion: true, freeze: true, spike: false });
  });
});
