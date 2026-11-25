/**
 * Reading the registry's current state: is it there at all, the lots, who
 * holds which role, and the chain's clock.
 *
 * Every function here is a read over JSON-RPC and returns plain JavaScript
 * values (numbers, strings, null), so the rest of the app never handles
 * ethers' BigInt results or the zero address.
 */

import { ZeroAddress } from "ethers";

import { ROLE_KEYS, ROLES } from "../lib/constants.js";
import { getProvider, getRegistry } from "./provider.js";

/**
 * @typedef {{ cid: string, contentHash: string }} DocumentRef
 *
 * @typedef {object} Lot the contract's Batch struct in plain values
 * @property {number} id
 * @property {string} productHash
 * @property {string} manufacturer
 * @property {number} manufactureDate          Unix seconds
 * @property {number} registeredAt             Unix seconds
 * @property {string} custodian
 * @property {string|null} pendingCustodian    null when no hand-off is open
 * @property {number} status                   a value of the Status enum
 * @property {number} minTempTenthsC
 * @property {number} maxTempTenthsC
 * @property {number} sensorLogCount
 * @property {DocumentRef} metadata
 * @property {DocumentRef|null} certificate    null when the lot is not certified
 * @property {DocumentRef|null} latestSensorLog null when no sensor log was anchored
 */

/**
 * @typedef {{ ok: true } | { ok: false, problem: "not-configured"|"unreachable"|"wrong-chain"|"no-contract", chainId?: number }} RegistryCheck
 */

/**
 * Find out whether the configured registry can be used, and if not, why.
 * The four failures are told apart because each needs a different instruction
 * (see components/RegistryGate.jsx).
 *
 * @param {import("../lib/networks.js").Network} network
 * @returns {Promise<RegistryCheck>} never rejects
 */
export async function checkRegistry(network) {
  if (network.registry === null) return { ok: false, problem: "not-configured" };
  const provider = getProvider(network);
  try {
    const chainId = Number(await provider.send("eth_chainId", []));
    if (chainId !== network.chainId) return { ok: false, problem: "wrong-chain", chainId };
    // A local chain starts empty after every restart, so an address from an earlier run has no code.
    const code = await provider.getCode(network.registry);
    return code === "0x" ? { ok: false, problem: "no-contract" } : { ok: true };
  } catch {
    return { ok: false, problem: "unreachable" };
  }
}

/**
 * Convert a DocumentRef as ethers returns it.
 * @param {{ cid: string, contentHash: string }} ref
 * @returns {DocumentRef|null} null for the contract's "no document" value (an empty CID)
 */
function asDocumentRef(ref) {
  return ref.cid === "" ? null : { cid: ref.cid, contentHash: ref.contentHash };
}

/**
 * Convert the Batch struct as ethers returns it.
 * Ids, times and temperatures fit a JavaScript number comfortably (uint64 times are seconds).
 * @param {any} batch
 * @returns {Lot}
 */
function toLot(batch) {
  return {
    id: Number(batch.id),
    productHash: batch.productHash,
    manufacturer: batch.manufacturer,
    manufactureDate: Number(batch.manufactureDate),
    registeredAt: Number(batch.registeredAt),
    custodian: batch.custodian,
    pendingCustodian: batch.pendingCustodian === ZeroAddress ? null : batch.pendingCustodian,
    status: Number(batch.status),
    minTempTenthsC: Number(batch.minTempTenthsC),
    maxTempTenthsC: Number(batch.maxTempTenthsC),
    sensorLogCount: Number(batch.sensorLogCount),
    metadata: { cid: batch.metadata.cid, contentHash: batch.metadata.contentHash },
    certificate: asDocumentRef(batch.certificate),
    latestSensorLog: asDocumentRef(batch.latestSensorLog),
  };
}

/**
 * Read one lot with verifyBatch.
 *
 * @param {import("../lib/networks.js").Network} network
 * @param {number} lotId
 * @param {number} [blockNumber] read the state as of this block, so it can be compared with events up to the same block
 * @returns {Promise<Lot|null>} null when the registry has no lot with this id
 */
export async function readLot(network, lotId, blockNumber) {
  try {
    const batch = await getRegistry(network).verifyBatch(lotId, blockNumber === undefined ? {} : { blockTag: blockNumber });
    return toLot(batch);
  } catch (error) {
    if (error?.revert?.name === "BatchNotFound") return null;
    throw error;
  }
}

/**
 * Read every lot in the registry.
 *
 * totalBatches() followed by one verifyBatch(id) per lot. That is one small
 * call per lot (ethers sends them together as a JSON-RPC batch), which is fine
 * for the handful of lots of a demo. A registry with thousands of lots would
 * need paging or an event index instead of this loop.
 *
 * @param {import("../lib/networks.js").Network} network
 * @returns {Promise<Lot[]>} in id order
 */
export async function readAllLots(network) {
  const total = Number(await getRegistry(network).totalBatches());
  const lots = await Promise.all(Array.from({ length: total }, (_, index) => readLot(network, index + 1)));
  return lots.filter((lot) => lot !== null);
}

/**
 * Ask the contract which roles each address holds (hasRole for every address and role).
 *
 * @param {import("../lib/networks.js").Network} network
 * @param {string[]} addresses
 * @returns {Promise<Record<string, string[]>>} address -> role keys, in the order of ROLE_KEYS
 */
export async function readRoles(network, addresses) {
  const registry = getRegistry(network);
  const unique = [...new Set(addresses)];
  const held = await Promise.all(
    unique.map((address) => Promise.all(ROLE_KEYS.map((key) => registry.hasRole(ROLES[key].id, address)))),
  );
  return Object.fromEntries(unique.map((address, index) => [address, ROLE_KEYS.filter((_, position) => held[index][position])]));
}

/**
 * The accounts a local development node holds keys for and signs with on
 * request (Hardhat's twenty funded test accounts). A public endpoint returns
 * an empty list.
 *
 * @param {import("../lib/networks.js").Network} network
 * @returns {Promise<string[]>} checksummed addresses in the node's order
 */
export async function readNodeAccounts(network) {
  const signers = await getProvider(network).listAccounts();
  return signers.map((signer) => signer.address);
}

/**
 * The chain's current time: the timestamp of its latest block. The contract
 * compares dates with this clock, not with the browser's.
 *
 * @param {import("../lib/networks.js").Network} network
 * @returns {Promise<number>} Unix seconds
 */
export async function readChainTime(network) {
  const block = await getProvider(network).getBlock("latest");
  return block.timestamp;
}
