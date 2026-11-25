/**
 * Turns a failed contract call into a readable ContractRevertError.
 *
 * The registry reverts with Solidity custom errors, for example
 * InvalidStatus(batchId, current). On the wire that is four selector bytes
 * followed by ABI-encoded arguments, and a JSON-RPC client shows it as
 * "execution reverted (unknown custom error)" plus a hex string. This module
 * decodes the hex with the contract ABI and prints
 *
 *   InvalidStatus(batchId=2, current=Compromised)
 *
 * so the person watching the oracle sees which rule of the contract applied.
 * Enum and role arguments are translated to their names, because "current=4"
 * or a 32-byte role hash would mean nothing in a console line.
 *
 * It has no network access; the registry client hands it the error object
 * that ethers threw.
 */

import { id, isHexString } from "ethers";

import { ContractRevertError } from "../errors.js";

/** The contract's Status enum, in declaration order (IProvenanceRegistry.Status). */
export const STATUS_NAMES = Object.freeze(["Created", "InTransit", "Stored", "Delivered", "Compromised", "Recalled"]);

/** Number of leading statuses that are "active": Created, InTransit, Stored. Only active lots accept sensor data. */
const ACTIVE_STATUS_COUNT = 3;

/**
 * Name of a status value.
 * @param {number|bigint} status
 * @returns {string} for example "Stored"; "Status(9)" for a value outside the enum
 */
export function statusName(status) {
  return STATUS_NAMES[Number(status)] ?? `Status(${status})`;
}

/**
 * Tell whether a lot in this status accepts anchorSensorLog and reportExcursion.
 * @param {number|bigint} status
 * @returns {boolean}
 */
export function isActiveStatus(status) {
  const value = Number(status);
  return Number.isInteger(value) && value >= 0 && value < ACTIVE_STATUS_COUNT;
}

/**
 * The role identifiers of the registry, keyed by their bytes32 value. The
 * contract defines each role as keccak256 of its name (base/RegistryBase.sol),
 * and the admin role of OpenZeppelin AccessControl is zero.
 */
const ROLE_NAMES = new Map([
  [`0x${"00".repeat(32)}`, "DEFAULT_ADMIN_ROLE"],
  ...["REGULATOR_ROLE", "MANUFACTURER_ROLE", "DISTRIBUTOR_ROLE", "RETAILER_ROLE", "ORACLE_ROLE"].map((name) => [id(name), name]),
]);

/** What the errors the oracle can run into mean for it. Errors not listed are printed without a comment. */
const EXPLANATIONS = Object.freeze({
  BatchNotFound: "no lot has this id",
  InvalidStatus: "the lot is no longer active, and the contract accepts sensor data only for active lots",
  EmptyDocument: "the document reference has an empty CID or a zero content hash",
  ReadingWithinRange: "the reading is inside the lot's registered range, bounds included, so it is not an excursion",
  InvalidTimestamp: "the reading time is zero or later than the block timestamp",
  AccessControlUnauthorizedAccount: "the signing account does not hold the role this function requires",
});

/** Custom error arguments that are Status enum values, by error name and argument name. */
const STATUS_ARGUMENTS = Object.freeze({ InvalidStatus: ["current"], InvalidStatusTransition: ["from", "to"] });

/**
 * Find the revert data in an error thrown by ethers.
 *
 * ethers puts it in `error.data` when it recognised the node's answer. Nodes
 * differ in how they wrap it, so the raw JSON-RPC error kept in `error.info`
 * (and in `error.error`) is searched as a fallback.
 *
 * @param {any} error
 * @returns {string|null} "0x" + hex, or null when the error carries no revert data
 */
export function extractRevertData(error) {
  if (isHexString(error?.data) && error.data.length >= 10) return error.data;
  return searchForData(error?.info?.error, 0) ?? searchForData(error?.error, 0);
}

/**
 * Depth-limited search for a hex string under a "data" key.
 * @param {any} value
 * @param {number} depth
 * @returns {string|null}
 */
function searchForData(value, depth) {
  if (value === null || typeof value !== "object" || depth > 4) return null;
  // At least a 4-byte selector: shorter strings are not revert data.
  if (isHexString(value.data) && value.data.length >= 10) return value.data;
  for (const key of Object.keys(value)) {
    const found = searchForData(value[key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Decode an ethers error into the contract's custom error, if it carries one.
 *
 * @param {any} error an error thrown by an ethers call
 * @param {import("ethers").Interface} contractInterface the registry ABI
 * @returns {ContractRevertError|null} null when the error is not a contract revert
 */
export function decodeRevert(error, contractInterface) {
  const data = extractRevertData(error);
  const isCallException = error?.code === "CALL_EXCEPTION";
  if (data === null) {
    if (!isCallException) return null;
    // A revert without data: require(false), or a node that does not return the data.
    const reason = typeof error.reason === "string" && error.reason !== "" ? error.reason : "no reason given";
    return new ContractRevertError({ errorName: "unknown", detail: `execution reverted (${reason})` }, { cause: error });
  }

  let parsed = null;
  try {
    parsed = contractInterface.parseError(data);
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    return new ContractRevertError(
      { errorName: "unknown", detail: `unknown custom error with selector ${data.slice(0, 10)}`, explanation: "the ABI does not describe it; is the deployment newer than the ABI file?", data },
      { cause: error },
    );
  }

  const args = {};
  const parts = parsed.fragment.inputs.map((input, index) => {
    const name = input.name || `arg${index}`;
    const value = readable(parsed.name, name, input.type, parsed.args[index]);
    args[name] = value;
    return `${name}=${value}`;
  });
  return new ContractRevertError(
    { errorName: parsed.name, args, detail: `${parsed.name}(${parts.join(", ")})`, explanation: EXPLANATIONS[parsed.name] ?? "", data },
    { cause: error },
  );
}

/**
 * Render one decoded argument for a console line.
 * @param {string} errorName
 * @param {string} argumentName
 * @param {string} type Solidity type of the argument
 * @param {unknown} value as decoded by ethers (bigint for every integer type)
 * @returns {string|number}
 */
function readable(errorName, argumentName, type, value) {
  if (STATUS_ARGUMENTS[errorName]?.includes(argumentName)) return statusName(/** @type {bigint} */ (value));
  if (type === "bytes32" && ROLE_NAMES.has(String(value))) return ROLE_NAMES.get(String(value));
  if (typeof value === "bigint") {
    // Small integers (lot ids, temperatures, timestamps) become plain numbers; anything larger stays exact as text.
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  return String(value);
}
