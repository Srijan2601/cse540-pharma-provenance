/**
 * Tests for the oracle runner (src/oracle/runner.js) and its
 * retry helper.
 *
 * The runner is driven against a FAKE registry client (test/helpers/
 * fake-registry.js, which enforces the contract's rules in memory) and the
 * REAL local IPFS backend in a temporary directory. So every log the runner
 * anchors is fetched back by its CID and checked the way a verifier would:
 * the bytes hash to the content hash that went "on-chain", the CID is the
 * hash of the bytes, and the document validates against the schema.
 *
 * Time is fully controlled: the clock is a variable, and the injected sleep
 * advances it instead of waiting, so a monitor run of many sample intervals
 * takes milliseconds.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createDocuments } from "../src/documents/index.js";
import { ChainError, ContractRevertError, NonceConsumedError, StorageError, TransientChainError } from "../src/errors.js";
import { LocalBackend, LocalStore, computeContentHash, computeRawCid } from "../src/ipfs/index.js";
import { DEFAULT_RETRY_POLICY, abortableSleep, isTransientError, withRetry } from "../src/oracle/retry.js";
import { isOutOfRange } from "../src/oracle/rule.js";
import { createOracleRunner, systemClock } from "../src/oracle/runner.js";
import { FakeRegistry, STATUS } from "./helpers/fake-registry.js";
import { temporaryDirectory } from "./helpers/harness.js";

const START = 1_794_300_000;
const DEFAULT_SETTINGS = { seed: 540, sampleSeconds: 60, logSize: 12, runLength: 3 };

/**
 * Everything a runner test needs: a fake registry, real local storage in a
 * temporary directory, a controllable clock, and a runner wired to them.
 *
 * @param {import("node:test").TestContext} t
 * @param {object} [options]
 * @param {Partial<typeof DEFAULT_SETTINGS>} [options.settings]
 * @param {object} [options.registry] options of FakeRegistry
 * @param {(storage: object) => object} [options.wrapStorage] replace the storage the runner sees (to inject failures)
 */
async function oracle(t, { settings = {}, registry: registryOptions = {}, wrapStorage = (storage) => storage } = {}) {
  const registry = new FakeRegistry({ time: START, ...registryOptions });
  const storage = new LocalBackend({ store: new LocalStore({ dir: await temporaryDirectory(t) }) });
  const documents = createDocuments();
  const merged = { ...DEFAULT_SETTINGS, ...settings };

  let now = START;
  let ticks = 0;
  const events = [];
  const sleeps = [];
  /** Functions called after each sampling round with its number (1, 2, ...): the place to change the world mid-run. */
  const afterTick = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
    now += ms / 1000;
    // Retry waits are at most a few seconds; the wait between sampling rounds is a sample interval.
    if (ms > 5000) {
      ticks += 1;
      for (const hook of afterTick) await hook(ticks);
    }
  };
  const runner = createOracleRunner({
    registry,
    storage: wrapStorage(storage),
    documents,
    settings: merged,
    clock: () => Math.floor(now),
    sleep,
    emit: (event) => events.push(event),
  });

  /**
   * Fetch an anchored log by the CID that went to the registry and verify it like a patient's verify page would.
   * @param {{ cid: string, contentHash: string }} transaction a record of the fake registry
   * @returns {Promise<object>} the parsed sensor-log document
   */
  async function verifiedLog(transaction) {
    const bytes = await storage.get(transaction.cid);
    assert.equal(computeContentHash(bytes), transaction.contentHash, "keccak256 of the stored bytes equals the on-chain content hash");
    assert.equal(computeRawCid(bytes), transaction.cid, "the CID is the hash of the stored bytes");
    const { type, document } = documents.parse(bytes);
    assert.equal(type, "sensor-log");
    return document;
  }

  return {
    registry,
    storage,
    documents,
    runner,
    events,
    sleeps,
    afterTick,
    settings: merged,
    verifiedLog,
    setTime: (value) => (now = value),
    eventsOf: (name) => events.filter((event) => event.event === name),
  };
}

/**
 * A storage wrapper whose next `failuresLeft` uploads fail (by default with a
 * transient error). A test can set `failuresLeft` later to end an outage.
 */
function flaky(failures, error = new StorageError("kubo", "The Kubo RPC API cannot be reached.", { transient: true })) {
  return (storage) => ({
    name: storage.name,
    uploads: 0,
    failuresLeft: failures,
    async add(bytes, options) {
      this.uploads += 1;
      if (this.failuresLeft > 0) {
        this.failuresLeft -= 1;
        throw error;
      }
      return storage.add(bytes, options);
    },
  });
}

/** Independent re-implementation of the rule, to check what the runner reported: index of the reading that completes a run of K. */
function firstRunOf(readings, range, runLength) {
  let run = 0;
  for (let index = 0; index < readings.length; index++) {
    run = isOutOfRange(readings[index].tenthsC, range) ? run + 1 : 0;
    if (run >= runLength) return index;
  }
  return -1;
}

describe("once: one log for one lot", () => {
  test("a normal lot gets a sensor log that validates, and its CID and hash are what the registry received", async (t) => {
    const { registry, runner, events, verifiedLog } = await oracle(t);
    const lotId = registry.addLot({ status: STATUS.Stored });

    const result = await runner.runOnce({ lotId });

    assert.equal(result.outcome, "anchored");
    assert.equal(registry.transactions.length, 1);
    const [transaction] = registry.transactions;
    assert.equal(transaction.kind, "anchor");
    assert.deepEqual({ cid: transaction.cid, contentHash: transaction.contentHash }, { cid: result.cid, contentHash: result.contentHash });
    assert.equal(result.txHash, transaction.txHash);
    assert.equal(result.logIndex, 1);

    const document = await verifiedLog(transaction);
    assert.deepEqual(
      { chainId: document.chainId, registry: document.registry, lotId: document.lotId, sensorId: document.sensorId, scenario: document.scenario, range: document.range, excursion: document.excursion },
      { chainId: 31337, registry: registry.address, lotId, sensorId: "sim-lot-1", scenario: "normal", range: { minTenthsC: 20, maxTenthsC: 80 }, excursion: null },
    );
    assert.equal(document.readings.length, 12);
    assert.ok(document.readings.every((reading) => !isOutOfRange(reading.tenthsC, document.range)));
    assert.equal(result.minTenthsC, Math.min(...document.readings.map((r) => r.tenthsC)));
    assert.equal(result.maxTenthsC, Math.max(...document.readings.map((r) => r.tenthsC)));

    // One line per action: exactly one event, and it carries what the console line shows.
    assert.equal(events.length, 1);
    assert.deepEqual(
      { event: events[0].event, lotId: events[0].lotId, readings: events[0].readings, cid: events[0].cid, txHash: events[0].txHash, logIndex: events[0].logIndex, at: events[0].at },
      { event: "anchor", lotId, readings: 12, cid: transaction.cid, txHash: transaction.txHash, logIndex: 1, at: START },
    );
  });

  test("the readings are spaced by the sample interval and end just before the chain's time", async (t) => {
    const { registry, runner, verifiedLog } = await oracle(t, { settings: { sampleSeconds: 30, logSize: 8 } });
    const lotId = registry.addLot();
    await runner.runOnce({ lotId });
    const document = await verifiedLog(registry.transactions[0]);
    assert.equal(document.readings.length, 8);
    assert.equal(document.readings.at(-1).t, START - 1);
    for (let i = 1; i < 8; i++) assert.equal(document.readings[i].t - document.readings[i - 1].t, 30);
    assert.equal(document.startedAt, document.readings[0].t);
    assert.equal(document.endedAt, document.readings.at(-1).t);
  });

  test("the excursion scenario leads to exactly one reportExcursion with the right reading and time", async (t) => {
    const { registry, runner, events, verifiedLog } = await oracle(t);
    const lotId = registry.addLot({ status: STATUS.InTransit });

    const result = await runner.runOnce({ lotId, scenario: "excursion" });

    assert.equal(result.outcome, "excursion");
    assert.equal(registry.transactions.length, 1);
    const [transaction] = registry.transactions;
    assert.equal(transaction.kind, "excursion");
    assert.equal(registry.calls.anchorSensorLog, 0, "the excursion log is not also anchored with anchorSensorLog");

    const document = await verifiedLog(transaction);
    const index = firstRunOf(document.readings, document.range, 3);
    assert.ok(index >= 2, "the run needs at least three readings");
    assert.deepEqual({ tenthsC: transaction.tenthsC, observedAt: transaction.observedAt }, { tenthsC: document.readings[index].tenthsC, observedAt: document.readings[index].t });
    assert.deepEqual(document.excursion, { t: transaction.observedAt, tenthsC: transaction.tenthsC, rule: "3 consecutive readings outside 2.0 C to 8.0 C" });
    assert.ok(transaction.tenthsC > 80);
    assert.ok(transaction.observedAt <= transaction.chainTime);

    assert.equal((await registry.readLot(lotId)).statusName, "Compromised");
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "excursion");
    assert.deepEqual(events[0].excursion, document.excursion);
  });

  test("the freeze scenario reports a reading below the minimum; the spike scenario is anchored without a report", async (t) => {
    const { registry, runner, verifiedLog } = await oracle(t);
    const frozen = registry.addLot({ minTenthsC: -250, maxTenthsC: -150 });
    const spiky = registry.addLot();

    assert.equal((await runner.runOnce({ lotId: frozen, scenario: "freeze" })).outcome, "excursion");
    const report = registry.transactionsOf(frozen)[0];
    assert.equal(report.kind, "excursion");
    assert.ok(report.tenthsC < -250);
    assert.equal((await verifiedLog(report)).excursion.rule, "3 consecutive readings outside -25.0 C to -15.0 C");

    const result = await runner.runOnce({ lotId: spiky, scenario: "spike" });
    assert.equal(result.outcome, "anchored");
    assert.equal(result.outOfRange, 1);
    assert.equal(result.longestRun, 1);
    const anchored = registry.transactionsOf(spiky)[0];
    assert.equal(anchored.kind, "anchor");
    const document = await verifiedLog(anchored);
    assert.equal(document.excursion, null);
    assert.equal(document.readings.filter((reading) => isOutOfRange(reading.tenthsC, document.range)).length, 1, "the spike is in the log, unreported");
    assert.equal((await registry.readLot(spiky)).active, true);
  });

  test("an inactive lot is skipped: nothing is uploaded and no transaction is sent", async (t) => {
    for (const status of [STATUS.Delivered, STATUS.Compromised, STATUS.Recalled]) {
      const { registry, runner, events } = await oracle(t, { wrapStorage: () => ({ name: "none", add: () => assert.fail("nothing may be uploaded") }) });
      const lotId = registry.addLot({ status });
      const result = await runner.runOnce({ lotId, scenario: "excursion" });
      assert.equal(result.outcome, "skipped");
      assert.match(result.reason, /only for active lots/);
      assert.equal(registry.transactions.length, 0);
      assert.equal(registry.attempts.length, 0);
      assert.deepEqual(events.map((event) => event.event), ["skip"]);
    }
  });

  test("every active status is served", async (t) => {
    for (const status of [STATUS.Created, STATUS.InTransit, STATUS.Stored]) {
      const { registry, runner } = await oracle(t);
      const lotId = registry.addLot({ status });
      assert.equal((await runner.runOnce({ lotId })).outcome, "anchored");
    }
  });

  test("a lot that does not exist is reported as a failure", async (t) => {
    const { registry, runner, events } = await oracle(t);
    const result = await runner.runOnce({ lotId: 7 });
    assert.equal(result.outcome, "failed");
    assert.equal(result.step, "read-lot");
    assert.match(result.error.message, /Lot 7 does not exist/);
    assert.equal(registry.transactions.length, 0);
    assert.equal(events[0].event, "failure");
  });

  test("repeated runs continue the series: each log differs and the log number goes up", async (t) => {
    const { registry, runner, verifiedLog, setTime } = await oracle(t);
    const lotId = registry.addLot();
    const temperatures = [];
    for (let i = 0; i < 3; i++) {
      registry.time = START + i * 1000;
      setTime(START + i * 1000);
      const result = await runner.runOnce({ lotId });
      assert.equal(result.logIndex, i + 1);
      temperatures.push((await verifiedLog(registry.transactions[i])).readings.map((reading) => reading.tenthsC));
    }
    assert.notDeepEqual(temperatures[0], temperatures[1]);
    assert.notDeepEqual(temperatures[1], temperatures[2]);
    assert.equal(new Set(registry.transactions.map((transaction) => transaction.cid)).size, 3);
  });

  test("after earlier logs, an excursion still starts from normal readings in its own log", async (t) => {
    const { registry, runner, verifiedLog } = await oracle(t);
    const lotId = registry.addLot({ sensorLogCount: 5 });
    await runner.runOnce({ lotId, scenario: "excursion" });
    const document = await verifiedLog(registry.transactions[0]);
    assert.ok(!isOutOfRange(document.readings[0].tenthsC, document.range), "the first reading is still in range");
    assert.ok(document.excursion !== null);
  });

  test("a scenario the lot's range cannot host is reported; nothing is sent", async (t) => {
    const { registry, runner } = await oracle(t);
    const lotId = registry.addLot({ minTenthsC: 32000, maxTenthsC: 32767 });
    const result = await runner.runOnce({ lotId, scenario: "excursion" });
    assert.equal(result.outcome, "failed");
    assert.equal(result.step, "simulate");
    assert.match(result.error.message, /above the maximum/);
    assert.equal(registry.attempts.length, 0);
  });

  test("when the chain's clock is behind this machine's, the log ends before the CHAIN's time", async (t) => {
    const { registry, runner, verifiedLog, setTime } = await oracle(t, { registry: { advanceOnDemand: false } });
    const lotId = registry.addLot();
    setTime(START + 3600); // the wall clock is an hour ahead of the latest block
    await runner.runOnce({ lotId, scenario: "excursion" });
    const [transaction] = registry.transactions;
    const document = await verifiedLog(transaction);
    assert.equal(document.readings.at(-1).t, START - 1);
    assert.ok(transaction.observedAt < START);
  });

  test("the runner asks the chain to catch up when its head is stale", async (t) => {
    const { registry, runner, verifiedLog, setTime } = await oracle(t);
    const lotId = registry.addLot();
    setTime(START + 3600);
    await runner.runOnce({ lotId });
    // The fake advanced its head to (wall clock - 15 s), as a development node does when nudged.
    const document = await verifiedLog(registry.transactions[0]);
    assert.equal(document.readings.at(-1).t, START + 3600 - 15 - 1);
    assert.ok(document.readings.at(-1).t <= registry.transactions[0].chainTime);
  });
});

describe("monitor: watching lots", () => {
  test("every active lot gets a log every SIM_LOG_SIZE readings; inactive lots are skipped", async (t) => {
    const { registry, runner, eventsOf, verifiedLog } = await oracle(t);
    const stored = registry.addLot({ status: STATUS.Stored });
    const delivered = registry.addLot({ status: STATUS.Delivered });
    const created = registry.addLot({ status: STATUS.Created });
    const recalled = registry.addLot({ status: STATUS.Recalled });
    const compromised = registry.addLot({ status: STATUS.Compromised });

    const stats = await runner.monitor({ maxTicks: 24 });

    assert.deepEqual(stats, { ticks: 24, anchored: 4, excursions: 0, failures: 0, discarded: 0 });
    assert.deepEqual(eventsOf("watch").map((event) => event.lotId), [stored, created]);
    assert.deepEqual(eventsOf("skip").map((event) => [event.lotId, event.status]), [[delivered, "Delivered"], [recalled, "Recalled"], [compromised, "Compromised"]]);
    for (const lotId of [delivered, recalled, compromised]) assert.equal(registry.transactionsOf(lotId).length, 0);

    for (const lotId of [stored, created]) {
      const logs = registry.transactionsOf(lotId);
      assert.deepEqual(logs.map((log) => [log.kind, log.logIndex]), [["anchor", 1], ["anchor", 2]]);
      const first = await verifiedLog(logs[0]);
      const second = await verifiedLog(logs[1]);
      assert.equal(first.readings.length, 12);
      assert.equal(second.readings.length, 12);
      assert.equal(first.lotId, lotId);
      // Live mode: one reading per sample interval, stamped when taken; the second log continues the first.
      assert.deepEqual(first.readings.map((reading) => reading.t), Array.from({ length: 12 }, (_, i) => START + i * 60));
      assert.equal(second.readings[0].t, START + 12 * 60);
    }
    // Each lot has its own sensor: the curves differ.
    const a = await verifiedLog(registry.transactionsOf(stored)[0]);
    const b = await verifiedLog(registry.transactionsOf(created)[0]);
    assert.notDeepEqual(a.readings.map((r) => r.tenthsC), b.readings.map((r) => r.tenthsC));
  });

  test("an excursion lot leads to exactly one reportExcursion and is then dropped from the watch list", async (t) => {
    const { registry, runner, eventsOf, verifiedLog } = await oracle(t);
    const healthy = registry.addLot();
    const failing = registry.addLot();

    const stats = await runner.monitor({ scenarios: { [failing]: "excursion" }, maxTicks: 36 });

    const reports = registry.transactionsOf(failing);
    assert.equal(reports.length, 1, "exactly one transaction for the failing lot");
    assert.equal(reports[0].kind, "excursion");
    assert.equal(registry.calls.reportExcursion, 1);

    const document = await verifiedLog(reports[0]);
    const index = firstRunOf(document.readings, document.range, 3);
    assert.equal(index, document.readings.length - 1, "the log is closed at the reading that completes the run, not at the end of the period");
    assert.deepEqual({ tenthsC: reports[0].tenthsC, observedAt: reports[0].observedAt }, { tenthsC: document.readings[index].tenthsC, observedAt: document.readings[index].t });
    assert.equal(reports[0].observedAt, START + index * 60, "the reading is stamped with the time it was taken");
    assert.ok(document.readings.length < 12);

    // Dropped: no further readings, logs or reads for the lot once it is Compromised.
    assert.deepEqual(eventsOf("unwatch").map((event) => [event.lotId, event.status]), [[failing, "Compromised"]]);
    assert.equal(stats.excursions, 1);
    // The healthy lot is unaffected and keeps getting its logs for all three periods.
    assert.deepEqual(registry.transactionsOf(healthy).map((log) => log.kind), ["anchor", "anchor", "anchor"]);
    assert.equal(stats.anchored, 3);
    assert.equal(stats.failures, 0);
  });

  test("a spike lot is anchored normally forever: the rule never triggers", async (t) => {
    const { registry, runner, verifiedLog } = await oracle(t);
    const lotId = registry.addLot();
    const stats = await runner.monitor({ defaultScenario: "spike", maxTicks: 60 });
    assert.deepEqual({ anchored: stats.anchored, excursions: stats.excursions }, { anchored: 5, excursions: 0 });
    let spikes = 0;
    for (const transaction of registry.transactionsOf(lotId)) {
      assert.equal(transaction.kind, "anchor");
      const document = await verifiedLog(transaction);
      assert.equal(document.excursion, null);
      spikes += document.readings.filter((reading) => isOutOfRange(reading.tenthsC, document.range)).length;
    }
    assert.equal(spikes, 6, "the out-of-range readings are recorded in the logs");
    assert.equal((await registry.readLot(lotId)).active, true);
  });

  test("a newly registered lot is discovered while the monitor runs", async (t) => {
    const { registry, runner, afterTick, eventsOf, verifiedLog } = await oracle(t);
    const first = registry.addLot();
    let second;
    afterTick.push((tick) => {
      if (tick === 5) second = registry.addLot({ minTenthsC: -250, maxTenthsC: -150 });
    });

    await runner.monitor({ maxTicks: 24 });

    assert.deepEqual(eventsOf("watch").map((event) => [event.lotId, event.at]), [[first, START], [second, START + 5 * 60]]);
    assert.equal(registry.transactionsOf(first).length, 2);
    const logs = registry.transactionsOf(second);
    assert.equal(logs.length, 1, "the new lot completes one log in the remaining 19 rounds");
    const document = await verifiedLog(logs[0]);
    assert.equal(document.lotId, second);
    assert.deepEqual(document.range, { minTenthsC: -250, maxTenthsC: -150 });
    assert.equal(document.readings[0].t, START + 5 * 60, "its first reading is taken in the round it was discovered");
  });

  test("a lot that stops being active is dropped without a transaction", async (t) => {
    const { registry, runner, afterTick, eventsOf } = await oracle(t);
    const delivered = registry.addLot();
    const other = registry.addLot();
    afterTick.push((tick) => {
      if (tick === 15) registry.setStatus(delivered, STATUS.Delivered);
    });

    const stats = await runner.monitor({ maxTicks: 36 });

    assert.deepEqual(registry.transactionsOf(delivered).map((log) => log.logIndex), [1], "only the log closed before the delivery");
    assert.deepEqual(eventsOf("unwatch").map((event) => [event.lotId, event.status, event.discarded]), [[delivered, "Delivered", 12]]);
    assert.equal(registry.transactionsOf(other).length, 3);
    assert.equal(stats.failures, 0, "dropping an inactive lot is not a failure");
    assert.equal(stats.discarded, 12);
    // No write was ever attempted for the lot after it became inactive.
    assert.equal(registry.attempts.filter((attempt) => attempt.lotId === delivered).length, 1);
  });

  test("an explicit list watches exactly those lots and ends when none is left", async (t) => {
    const { registry, runner, eventsOf } = await oracle(t);
    registry.addLot();
    const second = registry.addLot();
    registry.addLot({ status: STATUS.Recalled });

    const stats = await runner.monitor({ lots: [second, 3, 9], defaultScenario: "excursion" });

    assert.deepEqual(eventsOf("watch").map((event) => event.lotId), [second]);
    assert.deepEqual(eventsOf("skip").map((event) => [event.lotId, event.reason]), [[3, "the lot is Recalled"], [9, "the registry has no lot with this id"]]);
    assert.equal(registry.transactionsOf(1).length, 0, "lot 1 is not in the list");
    assert.equal(registry.transactionsOf(second).length, 1);
    // No maxTicks and no signal: the run ended by itself once the only watched lot was Compromised.
    assert.equal(eventsOf("stop")[0].reason, "idle");
    assert.equal(stats.excursions, 1);
    assert.equal(registry.calls.totalLots, 0, "an explicit list needs no discovery");
  });

  test("with nothing registered yet, the monitor keeps polling and picks up the first lot", async (t) => {
    const { registry, runner, afterTick, eventsOf } = await oracle(t);
    afterTick.push((tick) => {
      if (tick === 3) registry.addLot();
    });
    const stats = await runner.monitor({ maxTicks: 20 });
    assert.deepEqual(eventsOf("watch").map((event) => event.lotId), [1]);
    assert.equal(stats.anchored, 1);
    assert.equal(registry.calls.totalLots, 20);
  });

  test("the rounds are paced by the sample interval", async (t) => {
    const { registry, runner, sleeps } = await oracle(t, { settings: { sampleSeconds: 5, logSize: 3 } });
    registry.addLot();
    await runner.monitor({ maxTicks: 6 });
    assert.deepEqual(sleeps, [5000, 5000, 5000, 5000, 5000], "one wait between consecutive rounds, none after the last");
    assert.equal(registry.transactions.length, 2);
  });

  test("an aborted signal stops the monitor cleanly: no new step is started", async (t) => {
    const { registry, runner, afterTick, eventsOf } = await oracle(t);
    registry.addLot();
    const shutdown = new AbortController();
    afterTick.push((tick) => {
      if (tick === 14) shutdown.abort();
    });

    const stats = await runner.monitor({ signal: shutdown.signal });

    assert.equal(stats.ticks, 14);
    assert.equal(stats.anchored, 1);
    assert.equal(stats.discarded, 2, "the two readings of the unfinished log are reported as discarded");
    assert.deepEqual(eventsOf("stop").map((event) => event.reason), ["signal"]);
    assert.equal(registry.transactions.length, 1);

    // Already aborted before the start: nothing is read, sampled or sent.
    const fresh = await oracle(t);
    fresh.registry.addLot();
    const none = await fresh.runner.monitor({ signal: AbortSignal.abort() });
    assert.deepEqual(none, { ticks: 0, anchored: 0, excursions: 0, failures: 0, discarded: 0 });
    assert.equal(fresh.registry.calls.readLot, 0);
  });

  test("the first event describes the run and the last one summarizes it", async (t) => {
    const { registry, runner, events } = await oracle(t);
    registry.addLot();
    await runner.monitor({ maxTicks: 12 });
    assert.deepEqual(
      { event: events[0].event, lots: events[0].lots, defaultScenario: events[0].defaultScenario, sampleSeconds: events[0].sampleSeconds, logSize: events[0].logSize, runLength: events[0].runLength },
      { event: "start", lots: null, defaultScenario: "normal", sampleSeconds: 60, logSize: 12, runLength: 3 },
    );
    assert.deepEqual(events.map((event) => event.event), ["start", "watch", "anchor", "stop"]);
    assert.deepEqual({ ...events.at(-1), at: undefined }, { at: undefined, event: "stop", reason: "limit", ticks: 12, anchored: 1, excursions: 0, failures: 0, discarded: 0 });
  });
});

describe("the excursion rule in the runner", () => {
  test("a run that straddles two logs is detected, and the log says so", async (t) => {
    // Logs of 7 readings: the excursion scenario's run starts at the end of the first log.
    const { registry, runner, verifiedLog } = await oracle(t, { settings: { logSize: 7 } });
    const lotId = registry.addLot();

    await runner.monitor({ defaultScenario: "excursion", maxTicks: 30 });

    const transactions = registry.transactionsOf(lotId);
    assert.deepEqual(transactions.map((transaction) => transaction.kind), ["anchor", "excursion"]);
    const first = await verifiedLog(transactions[0]);
    const second = await verifiedLog(transactions[1]);
    assert.equal(first.readings.length, 7);
    assert.equal(first.excursion, null, "the first log ends inside the run, before it reaches K");

    const tail = first.readings.filter((reading) => isOutOfRange(reading.tenthsC, first.range)).length;
    assert.ok(tail >= 1 && tail <= 2, `the run has begun in the first log (${tail} readings)`);
    assert.equal(second.readings.length, 3 - tail, "the second log is closed as soon as the run is complete");
    assert.equal(second.excursion.rule, "3 consecutive readings outside 2.0 C to 8.0 C (the run began in the previous log)");
    assert.deepEqual({ t: second.excursion.t, tenthsC: second.excursion.tenthsC }, second.readings.at(-1));
    assert.equal(transactions[1].observedAt, second.readings.at(-1).t);

    // Counted over both logs together, the reported reading is exactly the one that completes the run.
    const all = [...first.readings, ...second.readings];
    assert.equal(firstRunOf(all, first.range, 3), all.length - 1);
  });

  test("K may exceed the log size: the run is counted across as many logs as it takes", async (t) => {
    const { registry, runner, verifiedLog } = await oracle(t, { settings: { logSize: 2, runLength: 5 } });
    const lotId = registry.addLot();
    await runner.monitor({ defaultScenario: "excursion", maxTicks: 40 });

    const transactions = registry.transactionsOf(lotId);
    assert.equal(transactions.at(-1).kind, "excursion");
    assert.ok(transactions.slice(0, -1).every((transaction) => transaction.kind === "anchor"));
    const readings = [];
    for (const transaction of transactions) readings.push(...(await verifiedLog(transaction)).readings);
    assert.equal(firstRunOf(readings, { minTenthsC: 20, maxTenthsC: 80 }, 5), readings.length - 1);
    assert.equal(transactions.at(-1).tenthsC, readings.at(-1).tenthsC);
  });

  test("K = 1 reports the first out-of-range reading, even a spike", async (t) => {
    const { registry, runner } = await oracle(t, { settings: { runLength: 1 } });
    const lotId = registry.addLot();
    const result = await runner.runOnce({ lotId, scenario: "spike" });
    assert.equal(result.outcome, "excursion");
    assert.equal(result.excursion.rule, "1 reading outside 2.0 C to 8.0 C");
    assert.equal(registry.transactionsOf(lotId)[0].kind, "excursion");
  });
});

describe("timestamps and the chain's clock", () => {
  test("no reading in any anchored log is later than the chain time at which it was anchored", async (t) => {
    const { registry, runner, verifiedLog } = await oracle(t);
    registry.addLot();
    registry.addLot();
    registry.addLot({ minTenthsC: -250, maxTenthsC: -150 });
    await runner.monitor({ scenarios: { 2: "excursion", 3: "freeze" }, maxTicks: 40 });
    await runner.runOnce({ lotId: 1, scenario: "spike" });

    assert.ok(registry.transactions.length >= 6);
    for (const transaction of registry.transactions) {
      const document = await verifiedLog(transaction);
      for (const reading of document.readings) {
        assert.ok(reading.t <= transaction.chainTime, `reading at ${reading.t} is later than chain time ${transaction.chainTime}`);
      }
      if (transaction.kind === "excursion") {
        assert.ok(transaction.observedAt > 0 && transaction.observedAt <= transaction.chainTime);
      }
    }
  });

  test("while the chain's latest block is older than the newest reading, the log is held back, then anchored whole", async (t) => {
    const { registry, runner, afterTick, eventsOf, verifiedLog } = await oracle(t, { registry: { advanceOnDemand: false } });
    const lotId = registry.addLot();
    // The chain stands still at START for 20 rounds, then produces a block with the current time.
    afterTick.push((tick) => {
      if (tick === 20) registry.time = START + 20 * 60;
    });

    const stats = await runner.monitor({ maxTicks: 30 });

    const waits = eventsOf("wait");
    assert.equal(waits.length, 20 - 11, "one wait per round from the round the log was full until the chain moved");
    assert.deepEqual({ lotId: waits[0].lotId, readings: waits[0].readings, chainTime: waits[0].chainTime, newestReading: waits[0].newestReading }, { lotId, readings: 12, chainTime: START, newestReading: START + 11 * 60 });
    assert.equal(registry.attempts.length, 1, "nothing was sent while the chain was behind");

    const [transaction] = registry.transactions;
    const document = await verifiedLog(transaction);
    assert.equal(document.readings.length, 21, "the held readings are all in the log once it can be anchored");
    assert.ok(document.readings.every((reading) => reading.t <= transaction.chainTime));
    assert.equal(stats.failures, 0, "waiting for the chain is not a failure");
    assert.equal(stats.anchored, 1);
  });

  test("a clock that runs ahead of the chain delays the logs but does not block them, and no reading is lost", async (t) => {
    const { registry, runner, afterTick, eventsOf, verifiedLog } = await oracle(t, { registry: { advanceOnDemand: false } });
    const lotId = registry.addLot();
    // The chain produces blocks all the time, but its clock is 90 seconds behind this machine's.
    const skew = 90;
    registry.time = START - skew;
    afterTick.push((tick) => (registry.time = START + tick * 60 - skew));

    const stats = await runner.monitor({ maxTicks: 40 });

    const logs = [];
    for (const transaction of registry.transactionsOf(lotId)) {
      const document = await verifiedLog(transaction);
      assert.ok(document.readings.every((reading) => reading.t <= transaction.chainTime), "nothing newer than the chain's clock is submitted");
      // Each log is closed as soon as the chain's clock has passed its last reading: two rounds late.
      assert.ok(transaction.chainTime - document.readings.at(-1).t < 60);
      logs.push(document);
    }
    assert.deepEqual(logs.map((log) => log.readings.length), [12, 12, 12]);
    const times = logs.flatMap((log) => log.readings.map((reading) => reading.t));
    assert.deepEqual(times, Array.from({ length: 36 }, (_, i) => START + i * 60), "the logs follow each other without a gap or an overlap");
    assert.equal(stats.failures, 0);
    assert.ok(eventsOf("wait").length > 0 && eventsOf("wait").length <= 6, "the wait is short and happens once per log");
  });

  test("under the same clock offset an excursion is reported once the chain reaches the reading", async (t) => {
    const { registry, runner, afterTick, verifiedLog } = await oracle(t, { registry: { advanceOnDemand: false } });
    const lotId = registry.addLot();
    registry.time = START - 90;
    afterTick.push((tick) => (registry.time = START + tick * 60 - 90));

    await runner.monitor({ defaultScenario: "excursion", maxTicks: 20 });

    const [report] = registry.transactionsOf(lotId);
    assert.equal(registry.transactionsOf(lotId).length, 1);
    assert.equal(report.kind, "excursion");
    const document = await verifiedLog(report);
    assert.deepEqual(document.readings.at(-1), { t: report.observedAt, tenthsC: report.tenthsC }, "the log ends with the reading that completed the run");
    assert.equal(firstRunOf(document.readings, document.range, 3), document.readings.length - 1);
    assert.ok(report.observedAt <= report.chainTime);
  });

  test("an excursion is not reported before the chain has reached its time", async (t) => {
    const { registry, runner, afterTick, eventsOf } = await oracle(t, { registry: { advanceOnDemand: false } });
    const lotId = registry.addLot();
    afterTick.push((tick) => {
      if (tick === 10) registry.time = START + 10 * 60;
    });
    await runner.monitor({ defaultScenario: "excursion", maxTicks: 12 });

    assert.ok(eventsOf("wait").length >= 1);
    const [report] = registry.transactionsOf(lotId);
    assert.equal(report.kind, "excursion");
    assert.ok(report.observedAt <= report.chainTime, "the fake applies the contract's InvalidTimestamp rule against the latest block");
    assert.equal(registry.calls.reportExcursion, 1, "it was sent once, when it could be accepted");
  });
});

describe("failures: one lot never stops the others", () => {
  test("a reverting call is reported with the contract's error name, and the other lots continue", async (t) => {
    const { registry, runner, eventsOf } = await oracle(t);
    const first = registry.addLot();
    const rejected = registry.addLot();
    const third = registry.addLot();
    // The contract rejects the call although the lot looked active when it was read: the status
    // changed between the read and the transaction.
    registry.failNext("anchorSensorLog", new ContractRevertError({ errorName: "InvalidStatus", args: { batchId: rejected, current: "Recalled" }, detail: `InvalidStatus(batchId=${rejected}, current=Recalled)` }));
    // The fault applies to the next call of the method, so make the rejected lot the first one to be closed.
    const stats = await runner.monitor({ lots: [rejected, first, third], maxTicks: 24 });

    const failures = eventsOf("failure");
    assert.equal(failures.length, 1);
    assert.deepEqual(
      { lotId: failures[0].lotId, step: failures[0].step, errorName: failures[0].errorName, code: failures[0].code, consumed: failures[0].consumed },
      { lotId: rejected, step: "anchor", errorName: "InvalidStatus", code: "CONTRACT_REVERT", consumed: true },
    );
    assert.match(failures[0].error, /InvalidStatus\(batchId=2, current=Recalled\)/);
    assert.equal(eventsOf("retry").length, 0, "a revert is not retried: it would fail the same way");

    assert.equal(registry.transactionsOf(first).length, 2);
    assert.equal(registry.transactionsOf(third).length, 2);
    // The rejected lot itself carries on in the next period, because it is in fact still active.
    assert.deepEqual(registry.transactionsOf(rejected).map((log) => log.logIndex), [1]);
    assert.deepEqual({ failures: stats.failures, anchored: stats.anchored, discarded: stats.discarded }, { failures: 1, anchored: 5, discarded: 12 });
  });

  test("a lot that cannot be read does not block the lots after it", async (t) => {
    const { registry, runner, afterTick, eventsOf } = await oracle(t);
    registry.addLot();
    registry.addLot();
    // Both lots are read once when the monitor starts to watch them. From the second round on,
    // every read of lot 1 fails for good (not a transient error, so it is not retried).
    const read = registry.readLot.bind(registry);
    let rounds = 0;
    afterTick.push((tick) => (rounds = tick));
    registry.readLot = async (lotId) => {
      if (lotId === 1 && rounds >= 1) throw new ChainError("Reading lot 1 failed: the node returned garbage.");
      return read(lotId);
    };

    const stats = await runner.monitor({ maxTicks: 24 });

    assert.equal(registry.transactionsOf(1).length, 0);
    assert.equal(registry.transactionsOf(2).length, 2, "lot 2 is served although lot 1 fails in every round");
    // Lot 1's log is full from round 12 on, and each of the 13 rounds from then tries to close it.
    assert.equal(stats.failures, 13);
    assert.ok(eventsOf("failure").every((event) => event.lotId === 1 && event.step === "read-lot" && event.consumed === false));
    assert.equal(eventsOf("retry").length, 0);
  });

  test("a scenario that one lot's range cannot host leaves that lot alone and serves the others", async (t) => {
    const { registry, runner, eventsOf } = await oracle(t);
    const impossible = registry.addLot({ minTenthsC: 32000, maxTenthsC: 32767 });
    const fine = registry.addLot();
    const stats = await runner.monitor({ defaultScenario: "excursion", maxTicks: 12 });
    assert.deepEqual(eventsOf("failure").map((event) => [event.lotId, event.step]), [[impossible, "simulate"]]);
    assert.equal(registry.transactionsOf(impossible).length, 0);
    assert.equal(registry.transactionsOf(fine).length, 1);
    assert.equal(stats.excursions, 1);
  });

  test("a transient upload failure is retried with a bounded backoff, then succeeds", async (t) => {
    let wrapped;
    const { registry, runner, eventsOf, sleeps } = await oracle(t, { wrapStorage: (storage) => (wrapped = flaky(2)(storage)) });
    const lotId = registry.addLot();

    const result = await runner.runOnce({ lotId });

    assert.equal(result.outcome, "anchored");
    assert.equal(wrapped.uploads, 3);
    assert.deepEqual(eventsOf("retry").map((event) => [event.step, event.attempt, event.attempts, event.delayMs]), [["upload", 1, 4, 500], ["upload", 2, 4, 1000]]);
    assert.deepEqual(sleeps, [500, 1000]);
    assert.equal(registry.transactions.length, 1);
  });

  test("when the upload keeps failing, the cycle is reported after 4 tries and nothing is sent", async (t) => {
    let wrapped;
    const { registry, runner, eventsOf, sleeps } = await oracle(t, { wrapStorage: (storage) => (wrapped = flaky(Infinity)(storage)) });
    const lotId = registry.addLot();

    const result = await runner.runOnce({ lotId });

    assert.equal(result.outcome, "failed");
    assert.deepEqual({ step: result.step, consumed: result.consumed }, { step: "upload", consumed: false });
    assert.equal(wrapped.uploads, DEFAULT_RETRY_POLICY.attempts);
    assert.deepEqual(sleeps, [500, 1000, 2000], "the waits are bounded: 3.5 seconds in total");
    assert.equal(registry.attempts.length, 0);
    assert.equal(eventsOf("failure").length, 1);
    assert.match(eventsOf("failure")[0].error, /Kubo RPC API cannot be reached/);
  });

  test("a permanent upload error is not retried", async (t) => {
    let wrapped;
    const permanent = new StorageError("pinata", "Pinata rejected the credential (HTTP 401).", { status: 401 });
    const { registry, runner, eventsOf } = await oracle(t, { wrapStorage: (storage) => (wrapped = flaky(Infinity, permanent)(storage)) });
    registry.addLot();
    const result = await runner.runOnce({ lotId: 1 });
    assert.equal(result.outcome, "failed");
    assert.equal(wrapped.uploads, 1);
    assert.equal(eventsOf("retry").length, 0);
  });

  test("in the monitor, readings survive a storage outage and are anchored when it ends", async (t) => {
    let wrapped;
    const { registry, runner, afterTick, eventsOf, verifiedLog } = await oracle(t, { wrapStorage: (storage) => (wrapped = flaky(Infinity)(storage)) });
    const lotId = registry.addLot();
    afterTick.push((tick) => {
      if (tick === 15) wrapped.failuresLeft = 0; // the storage service is back
    });

    const stats = await runner.monitor({ maxTicks: 20 });

    assert.equal(eventsOf("failure").length, 4, "rounds 12 to 15 each tried and failed");
    assert.ok(eventsOf("failure").every((event) => event.step === "upload" && event.consumed === false));
    const [transaction] = registry.transactionsOf(lotId);
    const document = await verifiedLog(transaction);
    assert.equal(document.readings.length, 16, "no reading taken during the outage was lost");
    assert.equal(stats.discarded, 4, "only the unfinished log at the end of the run is discarded");
    assert.equal(registry.transactions.length, 1);
  });

  test("a transient RPC failure while reading the lot is retried", async (t) => {
    const { registry, runner, eventsOf } = await oracle(t);
    const lotId = registry.addLot();
    registry.failNext("readLot", new TransientChainError("Reading lot 1 failed: connect ECONNREFUSED."), { times: 2 });
    const result = await runner.runOnce({ lotId });
    assert.equal(result.outcome, "anchored");
    assert.deepEqual(eventsOf("retry").map((event) => event.step), ["read-lot", "read-lot"]);
  });

  test("a failing discovery call is reported and the known lots are still served", async (t) => {
    const { registry, runner, afterTick, eventsOf } = await oracle(t);
    registry.addLot();
    afterTick.push((tick) => {
      if (tick === 3) registry.failNext("totalLots", new TransientChainError("Reading the number of lots failed: timeout."), { times: 4 });
    });
    const stats = await runner.monitor({ maxTicks: 12 });
    assert.deepEqual(eventsOf("failure").map((event) => [event.lotId, event.step]), [[null, "discover"]]);
    assert.equal(stats.anchored, 1);
  });

  test("a storage backend that reports a different content hash is not trusted", async (t) => {
    const { registry, runner } = await oracle(t, {
      wrapStorage: (storage) => ({ name: "liar", add: async (bytes) => ({ ...(await storage.add(bytes)), contentHash: `0x${"11".repeat(32)}` }) }),
    });
    registry.addLot();
    const result = await runner.runOnce({ lotId: 1 });
    assert.equal(result.outcome, "failed");
    assert.equal(result.error.code, "STORAGE_HASH_MISMATCH");
    assert.equal(registry.attempts.length, 0);
  });

  test("an unexpected error inside one lot's handling is contained", async (t) => {
    const { registry, runner, eventsOf } = await oracle(t);
    registry.addLot();
    registry.addLot();
    const anchor = registry.anchorSensorLog.bind(registry);
    registry.anchorSensorLog = async (lotId, ...rest) => {
      if (lotId === 1) throw new RangeError("a defect that only lot 1 runs into");
      return anchor(lotId, ...rest);
    };
    const stats = await runner.monitor({ maxTicks: 24 });
    assert.equal(registry.transactionsOf(2).length, 2);
    assert.equal(stats.failures, 2);
    assert.ok(eventsOf("failure").every((event) => event.lotId === 1 && /defect/.test(event.error)));
  });
});

describe("retries never anchor twice", () => {
  test("lost confirmation: the transaction was mined, the retry finds it on-chain and sends nothing", async (t) => {
    const { registry, runner, eventsOf, verifiedLog } = await oracle(t);
    const lotId = registry.addLot();
    registry.failNext("anchorSensorLog", new TransientChainError("Anchoring a sensor log for lot 1 failed: socket hang up."), { after: true });

    const result = await runner.runOnce({ lotId });

    assert.equal(result.outcome, "anchored");
    assert.equal(result.recovered, true);
    assert.equal(result.txHash, null, "the hash is unknown, and the event says the log was confirmed by reading the lot");
    assert.equal(result.logIndex, 1);
    assert.equal(registry.transactions.length, 1, "exactly one transaction exists");
    assert.equal(registry.calls.anchorSensorLog, 1, "the second attempt read the lot first and did not send again");
    assert.equal((await registry.readLot(lotId)).sensorLogCount, 1);
    assert.equal(eventsOf("retry").length, 1);
    await verifiedLog(registry.transactions[0]);
  });

  test("lost confirmation of an excursion report: still exactly one report", async (t) => {
    const { registry, runner, eventsOf } = await oracle(t);
    const lotId = registry.addLot();
    registry.failNext("reportExcursion", new TransientChainError("Reporting an excursion for lot 1 failed: timeout.", { txHash: `0x${"ab".repeat(32)}` }), { after: true });

    const stats = await runner.monitor({ defaultScenario: "excursion", maxTicks: 30 });

    assert.equal(registry.transactionsOf(lotId).length, 1);
    assert.equal(registry.calls.reportExcursion, 1);
    assert.equal(stats.excursions, 1);
    const [event] = eventsOf("excursion");
    assert.equal(event.recovered, true);
    assert.equal(event.txHash, `0x${"ab".repeat(32)}`, "the hash the client learned before the confirmation was lost is reported");
    assert.deepEqual(eventsOf("unwatch").map((unwatch) => unwatch.lotId), [lotId]);
  });

  test("the call never reached the chain: it is sent again with the SAME nonce and mined once", async (t) => {
    const { registry, runner } = await oracle(t);
    const lotId = registry.addLot();
    registry.failNext("anchorSensorLog", new TransientChainError("Anchoring failed: connect ECONNREFUSED."), { times: 2 });

    const result = await runner.runOnce({ lotId });

    assert.equal(result.outcome, "anchored");
    assert.equal(result.recovered, false);
    assert.equal(registry.transactions.length, 1);
    assert.deepEqual(registry.attempts.map((attempt) => attempt.nonce), [0, 0, 0], "every attempt for one document uses the one reserved nonce");
    assert.equal(registry.calls.reserveNonce, 1);
  });

  test("the look-before-resend check itself may fail transiently without causing a second transaction", async (t) => {
    const { registry, runner } = await oracle(t);
    const lotId = registry.addLot();
    registry.failNext("anchorSensorLog", new TransientChainError("lost"), { after: true });
    // readLot call 1 is the read at the start of the cycle; call 2 is the check before the second attempt.
    const read = registry.readLot.bind(registry);
    let reads = 0;
    registry.readLot = async (id) => {
      reads += 1;
      if (reads === 2) throw new TransientChainError("Reading lot 1 failed: timeout.");
      return read(id);
    };

    const result = await runner.runOnce({ lotId });

    assert.equal(result.outcome, "anchored");
    assert.equal(result.recovered, true);
    assert.equal(registry.transactions.length, 1);
    assert.equal(registry.calls.anchorSensorLog, 1, "no attempt was sent without a successful look at the chain first");
  });

  test("nonce spent by our own mined attempt: recognised as success", async (t) => {
    const { registry, runner } = await oracle(t);
    const lotId = registry.addLot();
    registry.failNext("anchorSensorLog", new TransientChainError("lost"), { after: true });
    // Hide the mined log from the first check, as a lagging RPC backend would; the resend then
    // meets "nonce already used", and the check after that sees the log.
    const read = registry.readLot.bind(registry);
    let reads = 0;
    registry.readLot = async (id) => {
      reads += 1;
      const lot = await read(id);
      return reads === 2 ? { ...lot, sensorLogCount: 0, latestSensorLog: { cid: "", contentHash: `0x${"00".repeat(32)}` } } : lot;
    };

    const result = await runner.runOnce({ lotId });

    assert.equal(result.outcome, "anchored");
    assert.equal(result.recovered, true);
    assert.equal(registry.transactions.length, 1, "the second send was rejected by the nonce rule, so nothing was anchored twice");
    assert.deepEqual(registry.attempts.map((attempt) => attempt.nonce), [0, 0]);
  });

  test("nonce spent by someone else: the cycle fails; a second nonce is never used for the same document", async (t) => {
    const { registry, runner, eventsOf } = await oracle(t);
    const lotId = registry.addLot();
    const reserve = registry.reserveNonce.bind(registry);
    registry.reserveNonce = async () => {
      const nonce = await reserve();
      registry.nonce += 1; // another sender uses the oracle account in between
      return nonce;
    };

    const result = await runner.runOnce({ lotId });

    assert.equal(result.outcome, "failed");
    assert.ok(result.error instanceof NonceConsumedError);
    assert.equal(result.consumed, true);
    assert.equal(registry.transactions.length, 0);
    assert.deepEqual(registry.attempts.map((attempt) => attempt.nonce), [0], "one attempt, with the reserved nonce only");
    assert.equal(eventsOf("failure")[0].code, "NONCE_CONSUMED");
  });

  test("an unconfirmed log is not merged into the next one: no reading can end up in two logs", async (t) => {
    const { registry, runner, eventsOf, verifiedLog } = await oracle(t);
    const lotId = registry.addLot();
    // The first log's transaction can never be confirmed: every attempt times out without being mined.
    registry.failNext("anchorSensorLog", new TransientChainError("The transaction was not mined within 120 s; its outcome is still open."), { times: 4 });

    const stats = await runner.monitor({ maxTicks: 36 });

    const failures = eventsOf("failure");
    assert.equal(failures.length, 1);
    assert.deepEqual({ step: failures[0].step, consumed: failures[0].consumed, readings: failures[0].readings }, { step: "anchor", consumed: true, readings: 12 });
    assert.equal(stats.discarded, 12);

    const logs = [];
    for (const transaction of registry.transactionsOf(lotId)) logs.push(await verifiedLog(transaction));
    assert.equal(logs.length, 2, "the second and third periods are anchored normally");
    const times = logs.flatMap((log) => log.readings.map((reading) => reading.t));
    assert.equal(new Set(times).size, times.length, "no timestamp appears twice");
    assert.ok(Math.min(...times) >= START + 12 * 60, "the readings of the failed period are in no later log");
    assert.deepEqual(logs.map((log) => log.readings.length), [12, 12]);
  });

  test("after a report that could not be delivered, the next out-of-range reading reports again, once", async (t) => {
    const { registry, runner, eventsOf, verifiedLog } = await oracle(t);
    const lotId = registry.addLot();
    registry.failNext("reportExcursion", new TransientChainError("Reporting failed: connect ECONNREFUSED."), { times: 4 });

    const stats = await runner.monitor({ defaultScenario: "excursion", maxTicks: 30 });

    assert.equal(eventsOf("failure").length, 1);
    const reports = registry.transactionsOf(lotId);
    assert.equal(reports.length, 1, "the lot ends up Compromised exactly once");
    const document = await verifiedLog(reports[0]);
    assert.equal(document.readings.length, 1, "the very next reading, still out of range, completes the report");
    assert.match(document.excursion.rule, /the run began in the previous log/);
    assert.equal(stats.excursions, 1);
    assert.equal((await registry.readLot(lotId)).statusName, "Compromised");
  });

  test("identical cycles on two lots are separate documents: neither is mistaken for the other", async (t) => {
    const { registry, runner } = await oracle(t);
    registry.addLot();
    registry.addLot();
    await runner.monitor({ maxTicks: 12 });
    const [a, b] = registry.transactions;
    assert.notEqual(a.cid, b.cid);
    assert.notEqual(a.contentHash, b.contentHash);
    assert.deepEqual(registry.transactions.map((transaction) => transaction.nonce), [0, 1], "each document has its own nonce");
  });
});

describe("retry helper", () => {
  const transient = () => new TransientChainError("temporarily down");
  const instant = () => Promise.resolve();

  test("returns the first success and passes the attempt number", async () => {
    const seen = [];
    const value = await withRetry(async (attempt) => {
      seen.push(attempt);
      if (attempt < 3) throw transient();
      return "done";
    }, { sleep: instant });
    assert.equal(value, "done");
    assert.deepEqual(seen, [1, 2, 3]);
  });

  test("the backoff doubles, is capped, and the number of tries is bounded", async () => {
    const delays = [];
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw transient();
        },
        { attempts: 6, baseDelayMs: 100, maxDelayMs: 500, sleep: async (ms) => void delays.push(ms) },
      ),
      TransientChainError,
    );
    assert.equal(calls, 6);
    assert.deepEqual(delays, [100, 200, 400, 500, 500]);
  });

  test("an error that is not transient is thrown at once", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls += 1;
        throw new ContractRevertError({ errorName: "InvalidStatus", detail: "InvalidStatus(batchId=1, current=Recalled)" });
      }, { sleep: instant }),
      ContractRevertError,
    );
    assert.equal(calls, 1);
  });

  test("which errors count as transient", () => {
    assert.equal(isTransientError(new TransientChainError("x")), true);
    assert.equal(isTransientError(new StorageError("kubo", "unreachable", { transient: true })), true);
    assert.equal(isTransientError(new StorageError("kubo", "HTTP 503", { status: 503 })), true);
    assert.equal(isTransientError(new StorageError("pinata", "HTTP 429", { status: 429 })), true);
    assert.equal(isTransientError(new StorageError("pinata", "HTTP 401", { status: 401 })), false);
    assert.equal(isTransientError(new StorageError("kubo", "no Hash field")), false);
    assert.equal(isTransientError(new ChainError("x")), false);
    assert.equal(isTransientError(new NonceConsumedError(3)), false);
    assert.equal(isTransientError(new ContractRevertError({ errorName: "X", detail: "X()" })), false);
    assert.equal(isTransientError(new Error("x")), false);
    assert.equal(isTransientError(undefined), false);
  });

  test("onRetry is told about every retry before the wait", async () => {
    const notes = [];
    await assert.rejects(withRetry(async () => { throw transient(); }, { attempts: 3, sleep: instant, onRetry: (info) => notes.push([info.attempt, info.attempts, info.delayMs, info.error.message]) }));
    assert.deepEqual(notes, [[1, 3, 500, "temporarily down"], [2, 3, 1000, "temporarily down"]]);
  });

  test("an aborted signal ends the retries after the attempt in progress", async () => {
    const shutdown = new AbortController();
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls += 1;
        shutdown.abort();
        throw transient();
      }, { signal: shutdown.signal, sleep: instant }),
      TransientChainError,
    );
    assert.equal(calls, 1);
  });

  test("abortableSleep waits, ends early when aborted, and never rejects", async () => {
    const started = Date.now();
    await abortableSleep(20);
    assert.ok(Date.now() - started >= 15);

    const shutdown = new AbortController();
    setTimeout(() => shutdown.abort(), 10);
    const before = Date.now();
    await abortableSleep(5000, shutdown.signal);
    assert.ok(Date.now() - before < 1000, "the wait ended with the signal");
    await abortableSleep(5000, AbortSignal.abort());
    await abortableSleep(0);
  });

  test("the default policy is a few seconds in total", () => {
    assert.deepEqual(DEFAULT_RETRY_POLICY, { attempts: 4, baseDelayMs: 500, maxDelayMs: 4000 });
    assert.ok(Object.isFrozen(DEFAULT_RETRY_POLICY));
  });
});

describe("runner construction", () => {
  test("settings must be whole numbers", () => {
    const base = { registry: {}, storage: {}, documents: {} };
    assert.throws(() => createOracleRunner({ ...base, settings: { seed: 1, sampleSeconds: 60, logSize: 12 } }), /settings\.runLength/);
    assert.throws(() => createOracleRunner({ ...base, settings: { ...DEFAULT_SETTINGS, logSize: "12" } }), /settings\.logSize/);
    assert.throws(() => createOracleRunner({ ...base, settings: undefined }), TypeError);
  });

  test("the default clock is the system time in whole seconds", () => {
    const now = systemClock();
    assert.ok(Number.isInteger(now));
    assert.ok(Math.abs(now - Date.now() / 1000) < 2);
  });
});
