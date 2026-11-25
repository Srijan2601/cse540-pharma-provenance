/**
 * Reading event history: a lot's full record for the verify page, and the list
 * of organizations for the dashboard.
 *
 * The contract keeps only current state; history lives in its events (design
 * decision O6). Two things make reading them more than one getLogs call:
 *
 *   - Public RPC endpoints refuse a query that spans too many blocks, so the
 *     range from the deployment block to the head is read in pages of
 *     network.logChunkBlocks blocks.
 *   - Pages refresh every few seconds. Re-reading the whole range each time
 *     would be wasteful, so a LogCursor remembers how far it has read and
 *     fetches only the new blocks.
 *
 * Reorganisations of the chain are not handled beyond a restart of the local
 * node: for a demo on a local chain and a low-traffic testnet that is enough.
 */

import { splitBlockRange } from "../lib/blockRanges.js";
import { getProvider, getRegistry } from "./provider.js";
import { readLot, readRoles } from "./registry.js";

/** The registry events that make up a lot's history; every one has the lot id as its first indexed topic. */
const LOT_EVENT_NAMES = new Set([
  "BatchRegistered",
  "TransferInitiated",
  "CustodyTransferred",
  "TransferCancelled",
  "StatusUpdated",
  "CertificateIssued",
  "SensorLogAnchored",
  "ExcursionReported",
  "BatchRecalled",
]);

/**
 * Reads the logs matching a topic filter incrementally.
 */
class LogCursor {
  /** Logs collected so far, in chain order. */
  #logs = [];
  /** First block not read yet. */
  #nextBlock;
  /** Number and hash of the last block read, to notice that the chain was replaced under us. */
  #anchor = null;
  /** Tail of the queue of advance() calls, so two overlapping refreshes cannot both append the same blocks. */
  #queue = Promise.resolve();

  /**
   * @param {import("../lib/networks.js").Network} network
   * @param {(string|null)[]} topics topic filter as eth_getLogs takes it
   */
  constructor(network, topics) {
    this.network = network;
    this.topics = topics;
    this.#nextBlock = network.deployBlock;
  }

  /**
   * Read up to a block and return everything collected so far.
   * @param {number} head block number to read up to, inclusive
   * @returns {Promise<import("ethers").Log[]>}
   */
  advance(head) {
    const result = this.#queue.then(() => this.#read(head));
    // The queue must survive a failed read, or one network hiccup would block every later refresh.
    this.#queue = result.catch(() => {});
    return result;
  }

  /**
   * @param {number} head
   * @returns {Promise<import("ethers").Log[]>}
   */
  async #read(head) {
    const provider = getProvider(this.network);

    // A local node starts a new chain on every restart. If the block we last read is gone or has
    // another hash, what was collected belongs to the old chain and is dropped.
    if (this.#anchor !== null) {
      const block = this.#anchor.number <= head ? await provider.getBlock(this.#anchor.number) : null;
      if (block?.hash !== this.#anchor.hash) {
        this.#logs = [];
        this.#nextBlock = this.network.deployBlock;
        this.#anchor = null;
      }
    }

    for (const range of splitBlockRange(this.#nextBlock, head, this.network.logChunkBlocks)) {
      const page = await provider.getLogs({ address: this.network.registry, topics: this.topics, ...range });
      this.#logs.push(...page);
      // Advanced page by page, so a failure half-way does not make the next refresh fetch a page twice.
      this.#nextBlock = range.toBlock + 1;
    }

    const headBlock = await provider.getBlock(head);
    if (headBlock) this.#anchor = { number: head, hash: headBlock.hash };
    return this.#logs;
  }
}

/**
 * Convert one decoded event argument to a plain value: BigInt to number
 * (ids, statuses, temperatures and times are all small), everything else as it is.
 * @param {unknown} value
 * @returns {unknown}
 */
function toPlain(value) {
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * @typedef {object} LotRecord
 * @property {import("./registry.js").Lot|null} lot   null when the registry has no lot with this id
 * @property {import("../lib/history.js").LotEvent[]} events the lot's events up to the same block as `lot`
 * @property {Record<string, string[]>} rolesByAddress  on-chain roles of every address that appears in the record
 * @property {number} readAt                             when this was read, milliseconds since the epoch
 */

/**
 * Create a reader for one lot's record. Each call returns the lot's current
 * state together with its whole event history, both as of the same block, so
 * the two can be compared with each other.
 *
 * @param {import("../lib/networks.js").Network} network
 * @param {number} lotId
 * @returns {() => Promise<LotRecord>}
 */
export function createLotRecordReader(network, lotId) {
  const registry = getRegistry(network);
  const provider = getProvider(network);
  // Topic 0 (the event signature) is left open; topic 1 is the lot id, indexed first in every lot event.
  const lotTopic = `0x${lotId.toString(16).padStart(64, "0")}`;
  const cursor = new LogCursor(network, [null, lotTopic]);
  /**
   * Block hash -> timestamp. A log names its block but not the block's time. Keyed by hash, not by
   * number, so the times of an earlier run are never reused after the local chain was restarted.
   */
  const timestamps = new Map();

  return async function readLotRecord() {
    const head = await provider.getBlockNumber();
    const lot = await readLot(network, lotId, head);
    if (lot === null) return { lot: null, events: [], rolesByAddress: {}, readAt: Date.now() };

    const logs = await cursor.advance(head);
    const events = [];
    for (const log of logs) {
      const parsed = registry.interface.parseLog(log);
      if (!parsed || !LOT_EVENT_NAMES.has(parsed.name)) continue;
      if (!timestamps.has(log.blockHash)) {
        timestamps.set(log.blockHash, (await provider.getBlock(log.blockHash)).timestamp);
      }
      events.push({
        name: parsed.name,
        args: Object.fromEntries(Object.entries(parsed.args.toObject()).map(([key, value]) => [key, toPlain(value)])),
        blockNumber: log.blockNumber,
        logIndex: log.index,
        timestamp: timestamps.get(log.blockHash),
      });
    }

    // Roles are read as they are now. An organization whose role was revoked after it handled the
    // lot is then shown without a role name, which is the honest answer the chain gives today.
    const addresses = new Set([lot.manufacturer, lot.custodian]);
    for (const event of events) {
      for (const key of ["manufacturer", "from", "to", "by", "regulator"]) {
        if (typeof event.args[key] === "string") addresses.add(event.args[key]);
      }
    }
    const rolesByAddress = await readRoles(network, [...addresses]);

    return { lot, events, rolesByAddress, readAt: Date.now() };
  };
}

/**
 * @typedef {{ address: string, roles: string[], nodeIndex: number|null }} Organization
 *   `nodeIndex` is the account's position among the local node's test accounts, or null.
 */

/**
 * Create a reader for the organization directory: every account that was ever
 * granted a role (from the RoleGranted events), plus any extra accounts the
 * caller is interested in, each with the roles it holds right now.
 *
 * The events only tell which addresses to ask about. Whether an address holds
 * a role today is always answered by hasRole, so a revoked role disappears.
 *
 * @param {import("../lib/networks.js").Network} network
 * @returns {(nodeAccounts?: string[], extra?: string[]) => Promise<Organization[]>}
 *   `nodeAccounts` are the local node's test accounts (listed first, in their order, even without a
 *   role); `extra` are further addresses to include, such as the signed-in wallet.
 */
export function createDirectoryReader(network) {
  const registry = getRegistry(network);
  const provider = getProvider(network);
  const cursor = new LogCursor(network, [registry.interface.getEvent("RoleGranted").topicHash]);

  return async function readDirectory(nodeAccounts = [], extra = []) {
    const logs = await cursor.advance(await provider.getBlockNumber());
    const granted = logs.map((log) => registry.interface.parseLog(log).args.account);
    const addresses = [...new Set([...nodeAccounts, ...granted, ...extra])];
    const rolesByAddress = await readRoles(network, addresses);

    return addresses.map((address) => {
      const nodeIndex = nodeAccounts.indexOf(address);
      return { address, roles: rolesByAddress[address] ?? [], nodeIndex: nodeIndex === -1 ? null : nodeIndex };
    });
  };
}
