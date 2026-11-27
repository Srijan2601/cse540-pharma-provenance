/**
 * Which registry deployments this build of the app knows, and which of them a
 * verify link is allowed to point at.
 *
 * A deployment is known in one of two ways:
 *   - a record file deployments/<network>.json written by scripts/deploy.js
 *     (localhost.json after `npm run deploy:local`; amoy.json, which is committed);
 *   - for the local chain only, the VITE_LOCAL_* settings, which override the
 *     record file.
 *
 * The list matters for safety, not just convenience: a counterfeiter can print
 * a QR code that points at a contract of their own, on which every lot looks
 * perfect. resolveVerifyTarget therefore accepts a link only when its chain
 * and registry are one of the deployments listed here.
 *
 * Pure functions: the caller passes the settings, the record files and the
 * page's host name (src/config.js does that for the running app).
 */

import { getAddress, isAddress } from "ethers";

/** Chain id of a local Hardhat node. */
export const LOCAL_CHAIN_ID = 31337;
/** Chain id of the Polygon Amoy testnet. */
export const AMOY_CHAIN_ID = 80002;

/**
 * Keyless public endpoint used for Amoy unless VITE_AMOY_RPC_URL is set.
 *
 * Why this one: the verify page reads a lot's history with eth_getLogs in
 * pages of LOG_CHUNK_BLOCKS blocks (5,000 on Amoy). In a test on 2026-11-25
 * this endpoint answered 40 of 40 requests and accepted event queries of up
 * to 10,000 blocks. Another keyless endpoint, polygon-amoy.drpc.org,
 * answered 31 of 40 and refused every event query over 100 blocks ("not
 * supported on free plan"), so a lot's history could not be read through it.
 */
const DEFAULT_AMOY_RPC_URL = "https://polygon-amoy-bor-rpc.publicnode.com";

/**
 * How many blocks one eth_getLogs request may span, per network. A local node
 * has no limit, but public endpoints cap the range (the default Amoy endpoint
 * above answered queries of 10,000 blocks in a test on 2026-11-25; drpc.org's
 * free plan refuses more than 100), so history is read in pages of this size.
 * Lower the Amoy value if the endpoint you configure rejects the range.
 */
const LOG_CHUNK_BLOCKS = Object.freeze({ [LOCAL_CHAIN_ID]: 50000, [AMOY_CHAIN_ID]: 5000 });

/**
 * How often pages re-read the chain, in milliseconds. Fast on the local node
 * so a demo feels live; slower on a shared public endpoint.
 */
const POLL_MS = Object.freeze({ [LOCAL_CHAIN_ID]: 4000, [AMOY_CHAIN_ID]: 15000 });

/**
 * @typedef {object} Network
 * @property {number} chainId
 * @property {string} name             what the chain is called on screen
 * @property {boolean} isLocal         true for the local Hardhat node, whose unlocked test accounts the app may use
 * @property {string} rpcUrl           JSON-RPC endpoint for reading (and, locally, for signing)
 * @property {string|null} registry    checksummed address of ProvenanceRegistry, or null when no deployment is known
 * @property {number} deployBlock      block the registry was deployed in; event history is read from here
 * @property {number} logChunkBlocks   page size of event queries, in blocks
 * @property {number} pollMs           refresh interval of pages reading this chain
 */

/**
 * Build the table of known networks.
 *
 * @param {object} input
 * @param {Record<string, string|undefined>} input.env  the VITE_* settings
 * @param {Record<string, any>} input.records           deployment records by file name without ".json"
 * @param {string} input.hostname                       host name the page was loaded from
 * @returns {{ networks: Record<number, Network>, defaultChainId: number }}
 *   `networks` always contains the local chain (possibly without a registry, so the app can explain
 *   how to deploy) and contains Amoy only when deployments/amoy.json exists.
 *   `defaultChainId` is the chain the home page and the dashboard use.
 */
export function resolveNetworks({ env, records, hostname }) {
  // Using the page's own host name instead of a fixed 127.0.0.1 lets a phone on the same Wi-Fi,
  // which loaded the app from the laptop's address, reach the laptop's node as well.
  const host = hostname || "127.0.0.1";
  const localRecord = records.localhost?.chainId === LOCAL_CHAIN_ID ? records.localhost : null;

  /** @type {Record<number, Network>} */
  const networks = {
    [LOCAL_CHAIN_ID]: {
      chainId: LOCAL_CHAIN_ID,
      name: "Local Hardhat chain",
      isLocal: true,
      rpcUrl: setting(env.VITE_LOCAL_RPC_URL) ?? `http://${host}:8545`,
      registry: toAddress(setting(env.VITE_LOCAL_REGISTRY_ADDRESS)) ?? toAddress(localRecord?.address),
      deployBlock: toBlockNumber(setting(env.VITE_LOCAL_DEPLOY_BLOCK)) ?? toBlockNumber(localRecord?.deployBlock) ?? 0,
      logChunkBlocks: LOG_CHUNK_BLOCKS[LOCAL_CHAIN_ID],
      pollMs: POLL_MS[LOCAL_CHAIN_ID],
    },
  };

  const amoyRegistry = records.amoy?.chainId === AMOY_CHAIN_ID ? toAddress(records.amoy.address) : null;
  if (amoyRegistry) {
    networks[AMOY_CHAIN_ID] = {
      chainId: AMOY_CHAIN_ID,
      name: "Polygon Amoy testnet",
      isLocal: false,
      rpcUrl: setting(env.VITE_AMOY_RPC_URL) ?? DEFAULT_AMOY_RPC_URL,
      registry: amoyRegistry,
      deployBlock: toBlockNumber(records.amoy.deployBlock) ?? 0,
      logChunkBlocks: LOG_CHUNK_BLOCKS[AMOY_CHAIN_ID],
      pollMs: POLL_MS[AMOY_CHAIN_ID],
    };
  }

  // The local demo is the main use, so it wins whenever a local deployment is configured. Amoy
  // becomes the default only for a build that knows nothing local (a hosted build, for example).
  const defaultChainId =
    networks[LOCAL_CHAIN_ID].registry === null && networks[AMOY_CHAIN_ID] ? AMOY_CHAIN_ID : LOCAL_CHAIN_ID;
  return { networks, defaultChainId };
}

/**
 * Decide which network a verify link refers to, and whether the app may trust it.
 *
 * @param {{ chainId: number|null, registry: string|null }} target from parseVerifyQuery; null means "not in the link"
 * @param {Record<number, Network>} networks
 * @param {number} defaultChainId
 * @returns {{ network: Network|null, trusted: boolean, reason: string|null }}
 *   `trusted` is true only when the link's chain is known and its registry (when given) is the
 *   deployment this app knows on that chain. `network` is null when the chain itself is unknown.
 */
export function resolveVerifyTarget(target, networks, defaultChainId) {
  const network = networks[target.chainId ?? defaultChainId] ?? null;
  if (network === null) {
    return { network: null, trusted: false, reason: `This app has no registry deployment on chain ${target.chainId}.` };
  }
  // A link without a registry (the short form `npm start` prints, or one typed by hand) means "the registry this app knows".
  if (target.registry !== null && network.registry !== null && target.registry !== network.registry) {
    return {
      network,
      trusted: false,
      reason: "The link points at a registry contract that is not the one this app knows.",
    };
  }
  return { network, trusted: true, reason: null };
}

/**
 * A setting counts as given only when it is a non-blank string.
 * @param {string|undefined} value
 * @returns {string|null}
 */
function setting(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} value
 * @returns {string|null} the checksummed address, or null when the value is not an address
 */
function toAddress(value) {
  return typeof value === "string" && isAddress(value) ? getAddress(value) : null;
}

/**
 * @param {unknown} value a number or a string of digits
 * @returns {number|null} null when the value is not a non-negative whole number
 */
function toBlockNumber(value) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
