/**
 * Names shared by the whole app: the lot statuses and the access-control roles
 * of the ProvenanceRegistry contract, with the words shown to people.
 *
 * The numbers and identifiers mirror contracts/interfaces/IProvenanceRegistry.sol
 * and contracts/base/RegistryBase.sol. They are constants of the deployed
 * contract, so they are written down here instead of being read over RPC on
 * every page load.
 */

import { id } from "ethers";

/** The contract's Status enum: name -> number, in declaration order. */
export const Status = Object.freeze({
  Created: 0,
  InTransit: 1,
  Stored: 2,
  Delivered: 3,
  Compromised: 4,
  Recalled: 5,
});

/** Status number -> words for a badge or a sentence ("the lot is in transit"). */
const STATUS_LABELS = Object.freeze(["Created", "In transit", "Stored", "Delivered", "Compromised", "Recalled"]);

/**
 * Words for a status number.
 * @param {number} status a value of the Status enum
 * @returns {string} for example "In transit"; "Unknown status" for a number outside the enum
 */
export function statusLabel(status) {
  return STATUS_LABELS[status] ?? "Unknown status";
}

/**
 * The five roles, keyed by a short name used throughout the app.
 *   id     the bytes32 role identifier, keccak256 of the Solidity constant's name
 *   label  what the role is called on screen (the contract says "retailer", people say "pharmacy")
 */
export const ROLES = Object.freeze({
  REGULATOR: Object.freeze({ key: "REGULATOR", id: id("REGULATOR_ROLE"), label: "Regulator" }),
  MANUFACTURER: Object.freeze({ key: "MANUFACTURER", id: id("MANUFACTURER_ROLE"), label: "Manufacturer" }),
  DISTRIBUTOR: Object.freeze({ key: "DISTRIBUTOR", id: id("DISTRIBUTOR_ROLE"), label: "Distributor" }),
  RETAILER: Object.freeze({ key: "RETAILER", id: id("RETAILER_ROLE"), label: "Pharmacy" }),
  ORACLE: Object.freeze({ key: "ORACLE", id: id("ORACLE_ROLE"), label: "IoT oracle" }),
});

/** Every role key, in the order panels and badges are shown. */
export const ROLE_KEYS = Object.freeze(Object.keys(ROLES));

/** The four roles the regulator grants to organizations (proposal Table I, "grant roles"). */
export const ORGANIZATION_ROLE_KEYS = Object.freeze(["MANUFACTURER", "DISTRIBUTOR", "RETAILER", "ORACLE"]);

/**
 * Words for a role key.
 * @param {string|null|undefined} roleKey a key of ROLES
 * @returns {string} for example "Pharmacy"; "Organization" when the role is unknown
 */
export function roleLabel(roleKey) {
  return ROLES[roleKey]?.label ?? "Organization";
}

/**
 * Words for a bytes32 role identifier, as carried by the contract's role errors.
 * @param {string} roleId 0x + 64 hex digits
 * @returns {string} the role's label, or "required" when the identifier is not one of ours
 */
export function roleLabelFromId(roleId) {
  const wanted = String(roleId).toLowerCase();
  const role = Object.values(ROLES).find((candidate) => candidate.id === wanted);
  return role ? role.label : "required";
}
