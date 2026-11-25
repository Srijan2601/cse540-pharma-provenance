/**
 * Read-only connections to the chains the app knows, and the registry contract
 * object built on them.
 *
 * Reading never needs a wallet: every page, including the patient verify
 * page, reads through a plain JSON-RPC provider. A signer is attached only
 * for the moment an organization sends a transaction (see state/session.jsx).
 *
 * The ABI is the committed deployments/abi/ProvenanceRegistry.json, never
 * Hardhat's artifacts/ folder, which is not in the repository.
 */

import { Contract, JsonRpcProvider, Network } from "ethers";

import registryAbi from "@deployments/abi/ProvenanceRegistry.json";

/** One provider per chain for the lifetime of the page. */
const providers = new Map();

/**
 * The read-only provider of a network.
 *
 * @param {import("../lib/networks.js").Network} network
 * @returns {JsonRpcProvider}
 */
export function getProvider(network) {
  let provider = providers.get(network.chainId);
  if (!provider) {
    provider = new JsonRpcProvider(network.rpcUrl, Network.from(network.chainId), {
      // The chain id is known from the configuration. Without this, ethers asks the node for it
      // before every use and keeps retrying (and logging) while the node is down.
      staticNetwork: true,
      // ethers would otherwise answer a repeated call from a 250 ms cache, which can hand a page
      // the state from just before its own transaction.
      cacheTimeout: -1,
    });
    providers.set(network.chainId, provider);
  }
  return provider;
}

/**
 * The registry contract of a network.
 *
 * @param {import("../lib/networks.js").Network} network a network with a known registry address
 * @param {import("ethers").ContractRunner} [runner] a signer for sending transactions; default: the read-only provider
 * @returns {Contract}
 */
export function getRegistry(network, runner = getProvider(network)) {
  return new Contract(network.registry, registryAbi, runner);
}
