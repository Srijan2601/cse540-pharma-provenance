/**
 * Which actions the contract would currently accept for a lot from an account.
 *
 * The dashboards use this to show only the buttons that can succeed (no
 * "Mark delivered" on a lot that is not stored, no "Accept" for a hand-off
 * addressed to someone else). It restates the role, custody and status checks
 * of contracts/modules/ in one place; the table in contracts/README.md
 * ("Function -> transition -> event") is the reference.
 *
 * This is a convenience, not a security boundary: the contract enforces the
 * same rules, and every transaction is still simulated before it is sent, so
 * a state that changed in the meantime ends in a plain-language message.
 */

import { Status } from "./constants.js";

/**
 * Compare two addresses regardless of letter case (a checksummed and a lower-case form are the same account).
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean} false when either is missing
 */
export function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * @typedef {object} LotActions
 * @property {boolean} canStartHandOff   initiateTransfer
 * @property {boolean} canCancelHandOff  cancelTransfer
 * @property {boolean} canAccept         acceptTransfer
 * @property {number|null} nextStatus    the status updateStatus may set (Stored or InTransit), or null when it may not be called
 * @property {boolean} canMarkDelivered  markDelivered
 * @property {boolean} canCertify        issueCertificate
 * @property {boolean} canRecall         recallBatch
 */

/**
 * Work out what an account may do with a lot right now.
 *
 * @param {{ status: number, custodian: string, pendingCustodian: string|null }} lot
 * @param {string} account    the signed-in address
 * @param {string[]} roles    role keys the account holds
 * @returns {LotActions}
 */
export function lotActions(lot, account, roles) {
  const has = (role) => roles.includes(role);
  const holdsLot = sameAddress(lot.custodian, account);
  const handOffOpen = lot.pendingCustodian !== null;
  const shipsLots = has("MANUFACTURER") || has("DISTRIBUTOR");

  let nextStatus = null;
  if (has("DISTRIBUTOR") && holdsLot && !handOffOpen) {
    if (lot.status === Status.InTransit) nextStatus = Status.Stored;
    if (lot.status === Status.Stored) nextStatus = Status.InTransit;
  }

  return {
    canStartHandOff: shipsLots && holdsLot && !handOffOpen && (lot.status === Status.Created || lot.status === Status.Stored),
    canCancelHandOff: shipsLots && holdsLot && handOffOpen,
    canAccept: (has("DISTRIBUTOR") || has("RETAILER")) && sameAddress(lot.pendingCustodian, account),
    nextStatus,
    canMarkDelivered: has("RETAILER") && holdsLot && lot.status === Status.Stored,
    canCertify: has("REGULATOR") && lot.status !== Status.Recalled,
    canRecall: has("REGULATOR") && lot.status !== Status.Recalled,
  };
}

/**
 * The organizations a sender may hand a lot to (the contract's routes, design
 * decision C3): any distributor, plus any pharmacy when the sender is itself
 * a distributor. Never the sender.
 *
 * @param {{ address: string, roles: string[] }[]} organizations every known account with its roles
 * @param {string} sender         the signed-in address
 * @param {string[]} senderRoles  role keys the sender holds
 * @returns {{ address: string, roles: string[] }[]}
 */
export function eligibleRecipients(organizations, sender, senderRoles) {
  const mayShipToPharmacy = senderRoles.includes("DISTRIBUTOR");
  return organizations.filter(
    (organization) =>
      !sameAddress(organization.address, sender) &&
      (organization.roles.includes("DISTRIBUTOR") || (mayShipToPharmacy && organization.roles.includes("RETAILER"))),
  );
}
