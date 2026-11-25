/**
 * FakeRegistry: an in-memory stand-in for the registry client
 * (src/oracle/registryClient.js), used to test the oracle runner without a
 * chain.
 *
 * It offers the same interface the runner uses and enforces the same rules
 * as the contract, so a runner that would send a transaction the contract
 * rejects fails its test here:
 *   - writes need an active lot (InvalidStatus), an existing lot
 *     (BatchNotFound) and a non-empty document reference (EmptyDocument);
 *   - reportExcursion needs a reading outside the range (ReadingWithinRange)
 *     and an observation time that is not zero and not later than the chain
 *     time (InvalidTimestamp); on success the lot becomes Compromised;
 *   - one account nonce carries at most one transaction (NonceConsumedError).
 * The timestamp rule is applied against the LATEST block time, which is the
 * stricter condition the oracle promises to meet.
 *
 * Every accepted transaction is recorded in `transactions`, and failures can
 * be scripted with failNext(): before the effect (the call never reached the
 * chain) or after it (the transaction was mined but the confirmation was
 * lost), which is exactly the case in which a careless retry anchors twice.
 */

import { ChainError, ContractRevertError, LotNotFoundError, NonceConsumedError } from "../../src/errors.js";
import { isActiveStatus, statusName } from "../../src/oracle/revert.js";

/** The contract's Status enum. */
export const STATUS = Object.freeze({ Created: 0, InTransit: 1, Stored: 2, Delivered: 3, Compromised: 4, Recalled: 5 });

/** A fixed, well-formed registry address for the documents built in tests (the one the schema examples use). */
export const FAKE_REGISTRY_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

const ZERO_HASH = `0x${"00".repeat(32)}`;

/** In-memory registry with the client interface the runner depends on. */
export class FakeRegistry {
  /**
   * @param {object} [options]
   * @param {number} [options.time]             chain time (timestamp of the latest block), Unix seconds
   * @param {boolean} [options.advanceOnDemand] whether chainTime({ atLeast }) can bring the head forward, as a
   *                                            live chain or a nudged development node does (default true)
   */
  constructor({ time = 1_794_300_000, advanceOnDemand = true } = {}) {
    this.chainId = 31337;
    this.address = FAKE_REGISTRY_ADDRESS;
    this.signerAddress = "0x00000000000000000000000000000000000000A4";
    this.info = { network: "localhost", chainId: this.chainId, address: this.address, signerAddress: this.signerAddress, signerSource: "fake", totalLots: 0, warnings: [] };
    /** Timestamp of the latest block. Tests move it to model a lagging or advancing chain. */
    this.time = time;
    this.advanceOnDemand = advanceOnDemand;
    /** @type {Map<number, { id: number, status: number, range: { minTenthsC: number, maxTenthsC: number }, sensorLogCount: number, latestSensorLog: { cid: string, contentHash: string }, registeredAt: number }>} */
    this.lots = new Map();
    /** Every accepted transaction, in order. */
    this.transactions = [];
    /** Every write that was attempted, accepted or not: { method, lotId, nonce }. */
    this.attempts = [];
    /** Number of calls per method, including failed ones. */
    this.calls = { totalLots: 0, readLot: 0, chainTime: 0, reserveNonce: 0, anchorSensorLog: 0, reportExcursion: 0 };
    /** The account's next nonce. */
    this.nonce = 0;
    this.blockNumber = 100;
    this.closed = false;
    /** @type {{ method: string, error: Error, after: boolean }[]} */
    this.faults = [];
  }

  /**
   * Register a lot.
   * @param {{ status?: number, minTenthsC?: number, maxTenthsC?: number, sensorLogCount?: number }} [lot]
   * @returns {number} the new lot id (1, 2, 3, ...)
   */
  addLot({ status = STATUS.Stored, minTenthsC = 20, maxTenthsC = 80, sensorLogCount = 0 } = {}) {
    const id = this.lots.size + 1;
    this.lots.set(id, { id, status, range: { minTenthsC, maxTenthsC }, sensorLogCount, latestSensorLog: { cid: "", contentHash: ZERO_HASH }, registeredAt: this.time });
    return id;
  }

  /**
   * Change a lot's status, as a custody action, a recall or a delivery would.
   * @param {number} lotId
   * @param {number} status
   */
  setStatus(lotId, status) {
    this.lots.get(lotId).status = status;
  }

  /**
   * Make the next call(s) of a method fail.
   * @param {string} method one of the client methods
   * @param {Error} error what to throw
   * @param {{ after?: boolean, times?: number }} [options] `after`: apply the call's effect first, then throw
   *        (a mined transaction whose confirmation was lost); `times`: how many calls fail
   */
  failNext(method, error, { after = false, times = 1 } = {}) {
    for (let i = 0; i < times; i++) this.faults.push({ method, error, after });
  }

  /** Transactions of one lot. @param {number} lotId */
  transactionsOf(lotId) {
    return this.transactions.filter((transaction) => transaction.lotId === lotId);
  }

  /** @returns {Promise<number>} */
  async totalLots() {
    this.#enter("totalLots");
    return this.lots.size;
  }

  /**
   * @param {number} lotId
   * @returns {Promise<object>} a Lot as the real client returns it
   */
  async readLot(lotId) {
    this.#enter("readLot");
    const lot = this.lots.get(lotId);
    if (lot === undefined) throw new LotNotFoundError(lotId);
    return {
      id: lot.id,
      status: lot.status,
      statusName: statusName(lot.status),
      active: isActiveStatus(lot.status),
      range: { ...lot.range },
      sensorLogCount: lot.sensorLogCount,
      latestSensorLog: { ...lot.latestSensorLog },
      registeredAt: lot.registeredAt,
      custodian: "0x00000000000000000000000000000000000000C1",
    };
  }

  /**
   * @param {{ atLeast?: number }} [options]
   * @returns {Promise<number>}
   */
  async chainTime({ atLeast } = {}) {
    this.#enter("chainTime");
    if (atLeast !== undefined && this.time < atLeast && this.advanceOnDemand) {
      this.time = atLeast;
    }
    return this.time;
  }

  /** @returns {Promise<number>} */
  async reserveNonce() {
    this.#enter("reserveNonce");
    return this.nonce;
  }

  /**
   * @param {number} lotId
   * @param {{ cid: string, contentHash: string }} reference
   * @param {{ nonce: number }} options
   */
  async anchorSensorLog(lotId, reference, { nonce }) {
    return this.#transact("anchorSensorLog", lotId, reference, nonce, () => ({ kind: "anchor" }));
  }

  /**
   * @param {number} lotId
   * @param {{ tenthsC: number, t: number }} reading
   * @param {{ cid: string, contentHash: string }} reference
   * @param {{ nonce: number }} options
   */
  async reportExcursion(lotId, reading, reference, { nonce }) {
    return this.#transact("reportExcursion", lotId, reference, nonce, (lot) => {
      if (reading.t === 0 || reading.t > this.time) {
        throw revert("InvalidTimestamp", { timestamp: reading.t });
      }
      if (reading.tenthsC >= lot.range.minTenthsC && reading.tenthsC <= lot.range.maxTenthsC) {
        throw revert("ReadingWithinRange", { readingTenthsC: reading.tenthsC, minTempTenthsC: lot.range.minTenthsC, maxTempTenthsC: lot.range.maxTenthsC });
      }
      lot.status = STATUS.Compromised;
      return { kind: "excursion", tenthsC: reading.tenthsC, observedAt: reading.t };
    });
  }

  /** @returns {Promise<void>} */
  async close() {
    this.closed = true;
  }

  /**
   * Count a call and throw a scripted "before" fault if one is queued for it.
   * @param {string} method
   * @returns {{ method: string, error: Error, after: boolean }|undefined} a queued "after" fault, to be thrown once the effect is applied
   */
  #enter(method) {
    this.calls[method] += 1;
    const index = this.faults.findIndex((fault) => fault.method === method);
    if (index === -1) return undefined;
    const [fault] = this.faults.splice(index, 1);
    if (!fault.after) throw fault.error;
    return fault;
  }

  /**
   * The shared part of both write functions: scripted faults, the nonce rule, the contract's checks, the record.
   * @param {string} method
   * @param {number} lotId
   * @param {{ cid: string, contentHash: string }} reference
   * @param {number} nonce
   * @param {(lot: object) => object} effect applies the method-specific checks and state change; returns fields for the record
   */
  async #transact(method, lotId, reference, nonce, effect) {
    this.attempts.push({ method, lotId, nonce });
    const lateFault = this.#enter(method);
    if (!Number.isSafeInteger(nonce)) throw new TypeError("The fake registry was called without a reserved nonce.");
    if (nonce < this.nonce) throw new NonceConsumedError(nonce);
    if (nonce > this.nonce) throw new ChainError(`Nonce too high: expected ${this.nonce}, got ${nonce}.`);

    const lot = this.lots.get(lotId);
    if (lot === undefined) throw revert("BatchNotFound", { batchId: lotId });
    if (!isActiveStatus(lot.status)) throw revert("InvalidStatus", { batchId: lotId, current: statusName(lot.status) });
    if (reference.cid === "" || reference.contentHash === ZERO_HASH) throw revert("EmptyDocument", {});
    const details = effect(lot);

    lot.sensorLogCount += 1;
    lot.latestSensorLog = { cid: reference.cid, contentHash: reference.contentHash };
    this.nonce += 1;
    this.blockNumber += 1;
    const txHash = `0x${String(this.transactions.length + 1).padStart(64, "0")}`;
    this.transactions.push({ ...details, lotId, cid: reference.cid, contentHash: reference.contentHash, logIndex: lot.sensorLogCount, nonce, chainTime: this.time, txHash });

    if (lateFault !== undefined) throw lateFault.error;
    return { txHash, blockNumber: this.blockNumber, logIndex: lot.sensorLogCount };
  }
}

/**
 * Build the error the real client throws for a contract revert.
 * @param {string} errorName
 * @param {Record<string, unknown>} args
 * @returns {ContractRevertError}
 */
function revert(errorName, args) {
  const detail = `${errorName}(${Object.entries(args).map(([name, value]) => `${name}=${value}`).join(", ")})`;
  return new ContractRevertError({ errorName, args, detail });
}
