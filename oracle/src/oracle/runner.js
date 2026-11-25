/**
 * The oracle runner: turns sensor readings into sensor-log
 * documents on IPFS and anchors them on-chain.
 *
 *   once     runOnce({ lotId, scenario }): one log for one lot, produced
 *            instantly (backfill) and ending just before the chain's time.
 *            Used to trigger an excursion on demand in a live demo.
 *   monitor  monitor({ lots, ... }): watches lots until stopped. Every
 *            SIM_SAMPLE_SECONDS it takes one reading per watched lot (live).
 *            A lot's log is closed when it holds SIM_LOG_SIZE readings, or at
 *            once when the excursion rule triggers, so an excursion is
 *            reported K readings after it starts instead of at the end of
 *            the log.
 *
 * Closing a log is the same pipeline in both modes:
 *
 *   read the lot (must be active) -> check the chain's time -> apply the rule
 *   -> build the document -> upload it -> anchorSensorLog, or reportExcursion
 *   when the rule triggered
 *
 * The runner depends on three injected collaborators and never on a global:
 *   registry   the registry client (or a fake in tests): all chain access
 *   storage    an IPFS storage backend: add(bytes) -> { cid, contentHash }
 *   documents  the document toolkit: buildSensorLog(fields)
 * plus a clock, a sleep function and an event sink. It prints nothing; every
 * action is emitted as a structured event, which the command line formats.
 *
 * Guarantees:
 *   - It never sends a transaction the contract would reject: the lot is read
 *     first and must be active, a reported reading is out of range by the
 *     rule's definition, and no reading is later than the chain's latest
 *     block time. If the contract rejects a call anyway (the lot changed in
 *     between), the decoded error is reported and the other lots carry on.
 *   - One lot failing never stops the others: every lot is handled inside
 *     its own error boundary, and retries are bounded.
 *   - A document is never anchored twice (see submitOnce).
 *   - Run lengths carry across logs, so an excursion that straddles two logs
 *     is still detected (see rule.js).
 */

import { MAX_LOG_READINGS } from "../config.js";
import { LotNotFoundError, NonceConsumedError, OracleError, SimulationError, TransientChainError } from "../errors.js";
import { createReadingSource } from "../simulator/source.js";
import { DEFAULT_RETRY_POLICY, abortableSleep, withRetry } from "./retry.js";
import { evaluateRule, isOutOfRange } from "./rule.js";

/**
 * In "once" mode the log should end at the present. If the chain's latest
 * block is older than this many seconds, the registry client is asked to let
 * the chain catch up first (it waits for a block on a public chain and mines
 * one on a local development node). A few seconds of lag are normal and not
 * worth waiting for.
 */
const HEAD_FRESHNESS_SECONDS = 15;

/**
 * @typedef {object} RunnerSettings
 * @property {number} seed           SIM_SEED
 * @property {number} sampleSeconds  SIM_SAMPLE_SECONDS
 * @property {number} logSize        SIM_LOG_SIZE: readings per log
 * @property {number} runLength      EXCURSION_RUN_LENGTH: the K of the excursion rule. It may exceed logSize,
 *                                   because a run is counted across consecutive logs of a lot.
 *
 * @typedef {object} CycleResult
 * @property {"anchored"|"excursion"|"skipped"|"failed"} outcome
 * @property {number} lotId
 * @property {string} [reason]        why a lot was skipped
 * @property {string} [step]          for "failed": read-lot, chain-time, simulate, build, upload, nonce, anchor or report
 * @property {string} [scenario]      scenario the readings came from
 * @property {number} [outOfRange]    out-of-range readings in the log
 * @property {number} [longestRun]    longest out-of-range run, including readings carried in from the previous log
 * @property {Error} [error]          for "failed"
 * @property {boolean} [consumed]     for "failed": true when the readings must not be submitted again (see closeLog)
 * @property {number} [readings]      number of readings in the log
 * @property {number} [minTenthsC]
 * @property {number} [maxTenthsC]
 * @property {string} [cid]
 * @property {string} [contentHash]
 * @property {string|null} [txHash]   null when the transaction was confirmed by reading the lot back
 * @property {number|null} [blockNumber]
 * @property {number|null} [logIndex] the lot's log number
 * @property {{ t: number, tenthsC: number, rule: string }|null} [excursion]
 * @property {boolean} [recovered]    true when an earlier attempt turned out to have been mined
 * @property {number} [runAtEnd]      out-of-range run length at the end of the log, carried into the next one
 *
 * @typedef {object} MonitorStats
 * @property {number} ticks       sampling rounds completed
 * @property {number} anchored    logs anchored with anchorSensorLog
 * @property {number} excursions  excursions reported
 * @property {number} failures    failed steps (each is also emitted as a "failure" event)
 * @property {number} discarded   readings taken but never anchored (lot became inactive, failed submission, shutdown)
 */

/**
 * The system clock in Unix seconds. The default for the injected clock.
 * @returns {number}
 */
export function systemClock() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Create a runner.
 *
 * @param {object} options
 * @param {object} options.registry    registry client: chainId, address, totalLots(), readLot(), chainTime(), reserveNonce(), anchorSensorLog(), reportExcursion()
 * @param {{ add: (bytes: Uint8Array, options?: { name?: string }) => Promise<{ cid: string, contentHash: string, size: number }> }} options.storage
 * @param {{ buildSensorLog: (fields: object) => { document: object, bytes: Uint8Array, contentHash: string } }} options.documents
 * @param {RunnerSettings} options.settings
 * @param {() => number} [options.clock]      current time in Unix seconds (stamps live readings and events)
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @param {(event: object) => void} [options.emit]   receives one object per action; see the README for the event types
 * @param {{ attempts: number, baseDelayMs: number, maxDelayMs: number }} [options.retry]
 * @returns {{
 *   runOnce: (options: { lotId: number, scenario?: string, signal?: AbortSignal }) => Promise<CycleResult>,
 *   monitor: (options?: { lots?: number[]|null, scenarios?: Record<number, string>, defaultScenario?: string, signal?: AbortSignal, maxTicks?: number }) => Promise<MonitorStats>
 * }}
 */
export function createOracleRunner({ registry, storage, documents, settings, clock = systemClock, sleep = abortableSleep, emit = () => {}, retry = DEFAULT_RETRY_POLICY }) {
  for (const name of ["seed", "sampleSeconds", "logSize", "runLength"]) {
    if (!Number.isSafeInteger(settings?.[name])) {
      throw new TypeError(`The runner needs settings.${name} as a whole number.`);
    }
  }
  const { seed, sampleSeconds, logSize, runLength } = settings;

  /**
   * Emit one event, stamped with the injected clock.
   * @param {object} event
   */
  const report = (event) => emit({ at: clock(), ...event });

  /**
   * Run a network call under the retry policy and report every retry.
   * @template T
   * @param {string} step name of the step, for the events
   * @param {number|null} lotId
   * @param {(attempt: number) => Promise<T>} operation
   * @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  function attempt(step, lotId, operation, signal) {
    return withRetry(operation, {
      ...retry,
      sleep,
      signal,
      onRetry: ({ attempt: number, attempts, delayMs, error }) => report({ event: "retry", lotId, step, attempt: number, attempts, delayMs, error: messageOf(error) }),
    });
  }

  /**
   * Send the transaction for one document EXACTLY ONCE, however many attempts it takes.
   *
   * The danger: a transaction is broadcast, the confirmation is lost (the RPC
   * connection drops, or the wait times out), and a naive retry broadcasts a
   * second transaction. Both are mined, and the same log is anchored twice.
   *
   * Two independent safeguards prevent that:
   *
   *   1. One document, one account nonce. The caller reserves a nonce before
   *      the first attempt, and every attempt for this document uses it. A
   *      chain mines at most one transaction per account and nonce, so of all
   *      the attempts at most one can ever take effect, even if several are
   *      in flight. A second nonce is never used for the same document: if
   *      the nonce turns out to be spent by something else, the cycle fails
   *      and is reported instead.
   *
   *   2. Look before sending again. Before any attempt after the first, the
   *      lot is read back. If its latest sensor log is already this document
   *      (same CID and content hash), an earlier attempt was mined, and the
   *      cycle is complete without another transaction. The comparison is
   *      exact because a log's bytes contain the lot id and the reading
   *      times, so no other cycle produces the same hash.
   *
   * (1) is what makes double anchoring impossible; (2) is what lets the
   * runner report success, with the right log number, when the first attempt
   * had in fact worked.
   *
   * @param {object} job
   * @param {number} job.lotId
   * @param {{ cid: string, contentHash: string }} job.reference the uploaded document
   * @param {{ t: number, tenthsC: number }|null} job.excursion the reading to report, or null to anchor only
   * @param {number} job.nonce the reserved account nonce
   * @param {string} job.step "anchor" or "report", for the retry events
   * @param {AbortSignal} [job.signal]
   * @returns {Promise<{ txHash: string|null, blockNumber: number|null, logIndex: number|null, recovered: boolean }>}
   */
  function submitOnce({ lotId, reference, excursion, nonce, step, signal }) {
    // The hash of a transaction that was broadcast but not confirmed, if the client could tell us one.
    let openTxHash = null;

    /**
     * Read the lot back; if the chain already shows this document, return the completed result.
     * @returns {Promise<{ txHash: string|null, blockNumber: null, logIndex: number, recovered: true }|null>}
     */
    const findOnChain = async () => {
      const lot = await registry.readLot(lotId);
      return sameDocument(lot.latestSensorLog, reference) ? { txHash: openTxHash, blockNumber: null, logIndex: lot.sensorLogCount, recovered: true } : null;
    };

    return attempt(
      step,
      lotId,
      async (number) => {
        if (number > 1) {
          const found = await findOnChain();
          if (found !== null) return found;
        }
        try {
          const submission =
            excursion === null
              ? await registry.anchorSensorLog(lotId, reference, { nonce })
              : await registry.reportExcursion(lotId, { tenthsC: excursion.tenthsC, t: excursion.t }, reference, { nonce });
          return { ...submission, recovered: false };
        } catch (error) {
          if (error instanceof TransientChainError && error.txHash) openTxHash = error.txHash;
          if (error instanceof NonceConsumedError) {
            // The nonce is spent: by our own earlier attempt (then the lot shows the document), or by
            // another sender using the oracle account (then this cycle fails; see safeguard 1).
            const found = await findOnChain();
            if (found !== null) return found;
          }
          throw error;
        }
      },
      signal,
    );
  }

  /**
   * Close one log: apply the rule, build and upload the document, send the transaction.
   *
   * It never throws. A failure is reported as an event and returned with a
   * `consumed` flag that tells the caller what to do with the readings:
   *   consumed = false   nothing was sent to the chain (the upload or the nonce
   *                      lookup failed). The readings may be submitted again later.
   *   consumed = true    a transaction may have been broadcast, or the readings
   *                      cannot form a valid document. They must NOT be put into
   *                      another log: a transaction of unknown outcome may still
   *                      be mined, and the same readings would then be anchored
   *                      in two different logs.
   *
   * @param {object} job
   * @param {import("./registryClient.js").Lot} job.lot the lot as just read from the chain (active)
   * @param {string} job.scenario
   * @param {string} job.sensorId
   * @param {{ t: number, tenthsC: number }[]} job.readings in time order, none later than the chain's time
   * @param {number} job.carriedRun out-of-range run length at the end of the lot's previous log
   * @param {AbortSignal} [job.signal]
   * @returns {Promise<CycleResult>}
   */
  async function closeLog({ lot, scenario, sensorId, readings, carriedRun, signal }) {
    const lotId = lot.id;
    const evaluation = evaluateRule(readings, lot.range, { runLength, carriedRun });
    const excursion = evaluation.excursion === null ? null : { t: evaluation.excursion.t, tenthsC: evaluation.excursion.tenthsC, rule: evaluation.rule };
    const temperatures = readings.map((reading) => reading.tenthsC);
    const summary = {
      lotId,
      scenario,
      readings: readings.length,
      minTenthsC: Math.min(...temperatures),
      maxTenthsC: Math.max(...temperatures),
      outOfRange: evaluation.outOfRangeCount,
      longestRun: evaluation.longestRun,
      runLength,
      excursion,
      runAtEnd: evaluation.runAtEnd,
    };

    let step = "build";
    // An invalid document stays invalid, so a build failure consumes the readings; see the comment above.
    let consumed = true;
    try {
      const built = documents.buildSensorLog({ chainId: registry.chainId, registry: registry.address, lotId, sensorId, scenario, range: lot.range, readings, excursion });

      step = "upload";
      consumed = false;
      // Content-addressed storage makes the upload idempotent: sending the same bytes again gives the same CID.
      const stored = await attempt(step, lotId, () => storage.add(built.bytes, { name: `sensor-log-lot-${lotId}-${readings[0].t}.json` }), signal);
      if (stored.contentHash !== built.contentHash) {
        throw new OracleError(`The storage backend reported content hash ${stored.contentHash} for a document whose hash is ${built.contentHash}.`, {
          code: "STORAGE_HASH_MISMATCH",
        });
      }
      const reference = { cid: stored.cid, contentHash: built.contentHash };

      step = "nonce";
      const nonce = await attempt(step, lotId, () => registry.reserveNonce(), signal);

      step = excursion === null ? "anchor" : "report";
      consumed = true;
      const submission = await submitOnce({ lotId, reference, excursion, nonce, step, signal });

      const result = { ...summary, ...reference, ...submission, outcome: excursion === null ? "anchored" : "excursion" };
      report({ event: excursion === null ? "anchor" : "excursion", ...result });
      return result;
    } catch (error) {
      report({ event: "failure", lotId, step, consumed, readings: readings.length, error: messageOf(error), code: error?.code ?? error?.name, errorName: error?.errorName });
      return { ...summary, outcome: "failed", step, consumed, error };
    }
  }

  /**
   * "once" mode: one backfilled log for one lot.
   *
   * @param {object} options
   * @param {number} options.lotId
   * @param {string} [options.scenario] default "normal"
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<CycleResult>}
   */
  async function runOnce({ lotId, scenario = "normal", signal }) {
    let step = "read-lot";
    try {
      const lot = await attempt(step, lotId, () => registry.readLot(lotId), signal);
      if (!lot.active) {
        const reason = `the lot is ${lot.statusName}, and the contract accepts sensor data only for active lots (Created, InTransit, Stored)`;
        report({ event: "skip", lotId, status: lot.statusName, reason });
        return { outcome: "skipped", lotId, reason };
      }

      step = "chain-time";
      const now = await attempt(step, lotId, () => registry.chainTime({ atLeast: clock() - HEAD_FRESHNESS_SECONDS }), signal);

      step = "simulate";
      // The series continues where the lot's anchored logs end, so repeated runs give different,
      // connected curves; the scenario's event (the failure, the spike) starts with this log.
      const source = createReadingSource({ seed, lotId, range: lot.range, scenario, sampleSeconds, startIndex: lot.sensorLogCount * logSize });
      const readings = source.backfill(logSize, now);

      return await closeLog({ lot, scenario: source.scenario, sensorId: source.sensorId, readings, carriedRun: 0, signal });
    } catch (error) {
      report({ event: "failure", lotId, step, consumed: false, error: messageOf(error), code: error?.code ?? error?.name, errorName: error?.errorName });
      return { outcome: "failed", lotId, step, consumed: false, error };
    }
  }

  /**
   * "monitor" mode: watch lots and anchor their logs until stopped.
   *
   * @param {object} [options]
   * @param {number[]|null} [options.lots]            watch exactly these lots; null (default) watches every active lot
   *                                                  and discovers newly registered ones by polling totalLots()
   * @param {Record<number, string>} [options.scenarios]  scenario per lot id, overriding the default
   * @param {string} [options.defaultScenario]        scenario of every other lot (default "normal")
   * @param {AbortSignal} [options.signal]            abort it to shut down: the step in progress finishes, nothing new starts
   * @param {number} [options.maxTicks]               stop after this many sampling rounds (default: run until aborted)
   * @returns {Promise<MonitorStats>}
   */
  async function monitor({ lots = null, scenarios = {}, defaultScenario = "normal", signal, maxTicks = Infinity } = {}) {
    /** @type {Map<number, { lotId: number, lot: import("./registryClient.js").Lot, scenario: string, source: import("../simulator/source.js").ReadingSource, buffer: { t: number, tenthsC: number }[], run: number }>} */
    const watched = new Map();
    /** @type {MonitorStats} */
    const stats = { ticks: 0, anchored: 0, excursions: 0, failures: 0, discarded: 0 };
    const explicit = lots !== null;
    // Explicit mode: the lots still to be examined. Discovery mode: the highest lot id examined so far.
    let pending = explicit ? [...new Set(lots)] : [];
    let examined = 0;

    /**
     * Report a failed step of the monitor itself and count it.
     * @param {number|null} lotId
     * @param {string} step
     * @param {unknown} error
     * @param {number} [kept] readings still buffered for the lot
     */
    const failed = (lotId, step, error, kept) => {
      stats.failures += 1;
      report({ event: "failure", lotId, step, consumed: false, readings: kept, error: messageOf(error), code: error?.code ?? error?.name, errorName: error?.errorName });
    };

    /**
     * Stop watching a lot. A lot never becomes active again (Delivered, Compromised and Recalled are
     * final for sensor data), so it is not looked at again.
     * @param {{ lotId: number, buffer: unknown[] }} watch
     * @param {string} status
     * @param {string} reason
     */
    const unwatch = (watch, status, reason) => {
      watched.delete(watch.lotId);
      stats.discarded += watch.buffer.length;
      report({ event: "unwatch", lotId: watch.lotId, status, reason, discarded: watch.buffer.length });
    };

    /**
     * Examine a lot once and start watching it if it is active.
     * @param {number} lotId
     * @returns {Promise<boolean>} false when the lot could not be read and must be examined again
     */
    async function consider(lotId) {
      let lot;
      try {
        lot = await attempt("read-lot", lotId, () => registry.readLot(lotId), signal);
      } catch (error) {
        if (error instanceof LotNotFoundError) {
          report({ event: "skip", lotId, reason: "the registry has no lot with this id" });
          return true;
        }
        failed(lotId, "read-lot", error);
        return false;
      }
      if (!lot.active) {
        report({ event: "skip", lotId, status: lot.statusName, reason: `the lot is ${lot.statusName}` });
        return true;
      }
      const scenario = scenarios[lotId] ?? defaultScenario;
      let source;
      try {
        source = createReadingSource({ seed, lotId, range: lot.range, scenario, sampleSeconds, clock, startIndex: lot.sensorLogCount * logSize });
      } catch (error) {
        if (!(error instanceof SimulationError)) throw error;
        // The scenario cannot be simulated for this lot's range; the lot is left alone and the others continue.
        failed(lotId, "simulate", error);
        return true;
      }
      watched.set(lotId, { lotId, lot, scenario, source, buffer: [], run: 0 });
      report({ event: "watch", lotId, status: lot.statusName, range: lot.range, scenario, sensorLogCount: lot.sensorLogCount });
      return true;
    }

    /** Update the watch list: retry explicit lots that could not be read, or discover newly registered lots. */
    async function refresh() {
      if (explicit) {
        const unread = [];
        for (const lotId of pending) {
          if (signal?.aborted || !(await consider(lotId))) unread.push(lotId);
        }
        pending = unread;
        return;
      }
      let total;
      try {
        total = await attempt("discover", null, () => registry.totalLots(), signal);
      } catch (error) {
        failed(null, "discover", error);
        return;
      }
      // Lot ids are consecutive from 1, so everything above the last examined id is new.
      while (examined < total && !signal?.aborted) {
        if (!(await consider(examined + 1))) break;
        examined += 1;
      }
    }

    /**
     * Close the lot's current log if the chain allows it.
     * @param {{ lotId: number, lot: object, scenario: string, source: { sensorId: string }, buffer: { t: number, tenthsC: number }[], run: number }} watch
     */
    async function flush(watch) {
      const newest = watch.buffer.at(-1).t;
      let lot;
      let head;
      let step = "read-lot";
      try {
        lot = await attempt(step, watch.lotId, () => registry.readLot(watch.lotId), signal);
        if (!lot.active) {
          unwatch(watch, lot.statusName, `the lot is ${lot.statusName}`);
          return;
        }
        step = "chain-time";
        head = await attempt(step, watch.lotId, () => registry.chainTime({ atLeast: newest }), signal);
      } catch (error) {
        // Nothing was sent, so the readings stay buffered and the log is closed at a later tick.
        failed(watch.lotId, step, error, watch.buffer.length);
        return;
      }
      watch.lot = lot;

      // The contract rejects a reading time later than block.timestamp, so only the readings the
      // chain's clock has already reached may be submitted. They are a prefix of the buffer, which
      // is in time order. Normally that is the whole buffer. If this machine's clock is ahead of
      // the chain's, the newest readings stay behind and go into the lot's next log, so a constant
      // offset between the two clocks delays a log but never blocks it.
      const ready = watch.buffer.filter((reading) => reading.t <= head);
      const due = ready.length >= logSize || evaluateRule(ready, lot.range, { runLength, carriedRun: watch.run }).triggered;
      if (!due) {
        report({ event: "wait", lotId: watch.lotId, readings: watch.buffer.length, chainTime: head, newestReading: newest });
        return;
      }

      const result = await closeLog({ lot, scenario: watch.scenario, sensorId: watch.source.sensorId, readings: ready, carriedRun: watch.run, signal });
      if (result.outcome === "failed") {
        stats.failures += 1;
        if (!result.consumed) return;
        stats.discarded += ready.length;
      }
      // The sensor did observe these readings whether or not they could be anchored, so the run
      // length continues from them. After a failed report it is already K or more, and the next
      // out-of-range reading triggers the rule again.
      watch.buffer = watch.buffer.slice(ready.length);
      watch.run = result.runAtEnd;
      if (result.outcome === "anchored") stats.anchored += 1;
      if (result.outcome === "excursion") {
        stats.excursions += 1;
        unwatch(watch, "Compromised", "the excursion was reported, which makes the lot Compromised");
      }
    }

    /**
     * Take one reading for a lot and close its log when it is full or the rule triggers.
     * @param {{ lotId: number, lot: { range: object }, source: { take: () => { t: number, tenthsC: number } }, buffer: { t: number, tenthsC: number }[], run: number }} watch
     */
    async function sample(watch) {
      watch.buffer.push(watch.source.take());
      // A log holds at most MAX_LOG_READINGS readings (the schema's limit). If logs cannot be closed for
      // that long (chain or storage down), the oldest reading is dropped; its effect on the run length is kept.
      while (watch.buffer.length > MAX_LOG_READINGS) {
        const dropped = watch.buffer.shift();
        watch.run = isOutOfRange(dropped.tenthsC, watch.lot.range) ? watch.run + 1 : 0;
        stats.discarded += 1;
      }
      const evaluation = evaluateRule(watch.buffer, watch.lot.range, { runLength, carriedRun: watch.run });
      if (evaluation.triggered || watch.buffer.length >= logSize) {
        await flush(watch);
      }
    }

    report({ event: "start", lots: explicit ? [...pending] : null, defaultScenario, sampleSeconds, logSize, runLength });
    let reason = "limit";
    for (;;) {
      if (signal?.aborted) {
        reason = "signal";
        break;
      }
      const tickStarted = clock();
      await refresh();
      for (const watch of [...watched.values()]) {
        if (signal?.aborted) break;
        try {
          await sample(watch);
        } catch (error) {
          // The error boundary of one lot: whatever went wrong here must not reach the other lots.
          failed(watch.lotId, "sample", error, watch.buffer.length);
        }
      }
      stats.ticks += 1;

      if (explicit && watched.size === 0 && pending.length === 0) {
        reason = "idle";
        break;
      }
      if (stats.ticks >= maxTicks) break;
      // The next reading is due one sample interval after this round started, however long the round took.
      await sleep(Math.max(0, sampleSeconds - Math.max(0, clock() - tickStarted)) * 1000, signal);
    }

    for (const watch of watched.values()) stats.discarded += watch.buffer.length;
    report({ event: "stop", reason, ...stats });
    return stats;
  }

  return Object.freeze({ runOnce, monitor });
}

/**
 * Compare two document references.
 * @param {{ cid: string, contentHash: string }} onChain
 * @param {{ cid: string, contentHash: string }} ours
 * @returns {boolean}
 */
function sameDocument(onChain, ours) {
  return onChain.cid === ours.cid && String(onChain.contentHash).toLowerCase() === ours.contentHash.toLowerCase();
}

/**
 * The message of anything that was thrown.
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
