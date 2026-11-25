/**
 * Where the registry is: loads the deployment record and the ABI that the
 * contract side of the repository writes (design decision O4).
 *
 *   ../deployments/<NETWORK>.json           { address, chainId, deployBlock, abi, ... }
 *                                           written by "npm run deploy:local" / "deploy:amoy"
 *   ../deployments/abi/ProvenanceRegistry.json   the ABI alone, committed with the contract
 *
 * Rules:
 *   - The address comes from the record, unless REGISTRY_ADDRESS overrides it.
 *     With an override the record is optional.
 *   - The ABI comes from the committed ABI file, and falls back to the copy
 *     inside the record when that file is absent.
 *   - The record must have been made on the chain that NETWORK names. A
 *     record for another chain means the wrong file or the wrong NETWORK, and
 *     using its address elsewhere would address an unrelated account.
 *   - A missing or unusable file is reported as a DeploymentError whose
 *     message names the file and the command that creates it. A stack trace
 *     would not tell the person running the demo what to do.
 *
 * This module only reads files. It never talks to the chain; whether the
 * address actually holds the registry is a pre-flight check of the registry
 * client.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { Interface, getAddress, isAddress } from "ethers";

import { DeploymentError } from "../errors.js";

/** The functions the oracle calls. An ABI without one of them belongs to another contract or an older draft. */
export const REQUIRED_FUNCTIONS = Object.freeze(["ORACLE_ROLE", "hasRole", "totalBatches", "verifyBatch", "anchorSensorLog", "reportExcursion"]);

/**
 * @typedef {object} Deployment
 * @property {string} address            registry address, EIP-55 checksummed
 * @property {number} chainId            chain the registry is deployed on
 * @property {number|null} deployBlock   block of the deployment transaction, or null when unknown (address override without a record)
 * @property {object[]} abi              the registry ABI
 * @property {string} addressSource      where the address came from, for the start-up line
 * @property {string} abiSource          where the ABI came from
 */

/**
 * Load the deployment the configuration points at.
 *
 * @param {import("../config.js").OracleConfig} config
 * @returns {Promise<Deployment>}
 * @throws {DeploymentError}
 */
export async function loadDeployment(config) {
  const { deploymentFile, abiFile, repoRoot } = config.paths;
  const shown = (file) => path.relative(repoRoot, file) || file;
  const deployCommand = `npm run deploy:${config.network === "amoy" ? "amoy" : "local"}`;

  const record = await readJson(deploymentFile, shown(deploymentFile));
  if (record === null && config.registryAddress === null) {
    throw new DeploymentError(
      `No deployment record at ${shown(deploymentFile)}, so the registry address for NETWORK=${config.network} is unknown.\n` +
        (config.network === "localhost"
          ? `In the repository root, start a node ("npm run node"), then run "${deployCommand}" and "npm run roles:local".\n`
          : `Deploy with "${deployCommand}" in the repository root (the record is committed afterwards).\n`) +
        "Alternatively set REGISTRY_ADDRESS to the address of a deployed registry.",
      { missing: true },
    );
  }

  let deployBlock = null;
  if (record !== null) {
    if (typeof record !== "object" || Array.isArray(record)) {
      throw new DeploymentError(`${shown(deploymentFile)} is not a deployment record (expected a JSON object). Re-run "${deployCommand}".`);
    }
    if (!Number.isSafeInteger(record.chainId)) {
      throw new DeploymentError(`${shown(deploymentFile)} has no numeric "chainId". Re-run "${deployCommand}".`);
    }
    if (record.chainId !== config.expectedChainId) {
      throw new DeploymentError(
        `${shown(deploymentFile)} was recorded on chain id ${record.chainId}, but NETWORK=${config.network} means chain id ${config.expectedChainId}. ` +
          `The file belongs to another network: re-run "${deployCommand}", or fix NETWORK.`,
      );
    }
    if (config.registryAddress === null && (typeof record.address !== "string" || !isAddress(record.address))) {
      throw new DeploymentError(`${shown(deploymentFile)} has no valid "address". Re-run "${deployCommand}".`);
    }
    if (Number.isSafeInteger(record.deployBlock) && record.deployBlock >= 0) {
      deployBlock = record.deployBlock;
    }
  }

  const abiDocument = await readJson(abiFile, shown(abiFile));
  // The committed ABI file is a bare array; an object with an "abi" key (a Hardhat artifact) is accepted too.
  const fromFile = Array.isArray(abiDocument) ? abiDocument : abiDocument?.abi;
  const abi = Array.isArray(fromFile) ? fromFile : record?.abi;
  if (!Array.isArray(abi)) {
    throw new DeploymentError(
      `No contract ABI: ${shown(abiFile)} ${abiDocument === null ? "does not exist" : "is not an ABI"}` +
        `${record === null ? "" : ` and ${shown(deploymentFile)} carries no "abi"`}. Run "npm run compile" in the repository root to write it.`,
      { missing: abiDocument === null },
    );
  }
  const abiSource = Array.isArray(fromFile) ? shown(abiFile) : shown(deploymentFile);
  assertOracleAbi(abi, abiSource);

  return {
    address: config.registryAddress ?? getAddress(record.address),
    chainId: config.expectedChainId,
    deployBlock,
    abi,
    addressSource: config.registryAddress === null ? shown(deploymentFile) : "REGISTRY_ADDRESS",
    abiSource,
  };
}

/**
 * Check that an ABI describes the functions the oracle calls.
 * @param {object[]} abi
 * @param {string} source file the ABI came from, for the message
 * @returns {void}
 * @throws {DeploymentError}
 */
function assertOracleAbi(abi, source) {
  let contract;
  try {
    contract = new Interface(abi);
  } catch (error) {
    throw new DeploymentError(`The ABI in ${source} cannot be parsed: ${error.shortMessage ?? error.message}`, { cause: error });
  }
  const missing = REQUIRED_FUNCTIONS.filter((name) => !contract.hasFunction(name));
  if (missing.length > 0) {
    throw new DeploymentError(
      `The ABI in ${source} lacks ${missing.join(", ")}, which the oracle calls. It is not the ProvenanceRegistry ABI, or it is out of date: run "npm run compile" in the repository root.`,
    );
  }
}

/**
 * Read and parse a JSON file.
 * @param {string} file absolute path
 * @param {string} shown the path to show in messages
 * @returns {Promise<any|null>} the parsed value, or null when the file does not exist
 * @throws {DeploymentError} when the file exists but cannot be read or parsed
 */
async function readJson(file, shown) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new DeploymentError(`Cannot read ${shown}: ${error.code ?? error.message}.`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DeploymentError(`${shown} is not valid JSON (${error.message}). Re-create it with the command that wrote it.`, { cause: error });
  }
}
