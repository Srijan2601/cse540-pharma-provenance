/**
 * Tests of the action rules: the dashboards must offer exactly what the
 * contract would accept from the signed-in account for a lot in its current
 * state (the table "Function -> transition -> event" in contracts/README.md).
 */

import { describe, expect, it } from "vitest";

import { eligibleRecipients, lotActions, sameAddress } from "./actions.js";
import { Status } from "./constants.js";

const MANUFACTURER = "0x1000000000000000000000000000000000000001";
const DISTRIBUTOR = "0x2000000000000000000000000000000000000002";
const OTHER_DISTRIBUTOR = "0x3000000000000000000000000000000000000003";
const PHARMACY = "0x4000000000000000000000000000000000000004";
const REGULATOR = "0x5000000000000000000000000000000000000005";

/** Names of the actions lotActions allows, for compact expectations. */
function allowed(lot, account, roles) {
  const actions = lotActions(lot, account, roles);
  return Object.entries(actions)
    .filter(([, value]) => value !== false && value !== null)
    .map(([name]) => name)
    .sort();
}

const lot = (status, custodian, pendingCustodian = null) => ({ status, custodian, pendingCustodian });

describe("lotActions", () => {
  it("lets a manufacturer start a hand-off for a lot it has just registered", () => {
    expect(allowed(lot(Status.Created, MANUFACTURER), MANUFACTURER, ["MANUFACTURER"])).toEqual(["canStartHandOff"]);
  });

  it("lets the sender cancel an open hand-off, and nothing else", () => {
    expect(allowed(lot(Status.InTransit, MANUFACTURER, DISTRIBUTOR), MANUFACTURER, ["MANUFACTURER"])).toEqual(["canCancelHandOff"]);
  });

  it("lets only the named recipient accept", () => {
    const offered = lot(Status.InTransit, MANUFACTURER, DISTRIBUTOR);
    expect(allowed(offered, DISTRIBUTOR, ["DISTRIBUTOR"])).toEqual(["canAccept"]);
    expect(allowed(offered, OTHER_DISTRIBUTOR, ["DISTRIBUTOR"])).toEqual([]);
  });

  it("lets a distributor ship or hand off a stored lot", () => {
    const actions = lotActions(lot(Status.Stored, DISTRIBUTOR), DISTRIBUTOR, ["DISTRIBUTOR"]);
    expect(actions.canStartHandOff).toBe(true);
    expect(actions.nextStatus).toBe(Status.InTransit);
    expect(actions.canMarkDelivered).toBe(false);
  });

  it("lets a distributor store a lot it moved, but not hand it off while it is in transit", () => {
    const actions = lotActions(lot(Status.InTransit, DISTRIBUTOR), DISTRIBUTOR, ["DISTRIBUTOR"]);
    expect(actions.nextStatus).toBe(Status.Stored);
    expect(actions.canStartHandOff).toBe(false);
  });

  it("offers no status update while a hand-off is open", () => {
    expect(lotActions(lot(Status.InTransit, DISTRIBUTOR, PHARMACY), DISTRIBUTOR, ["DISTRIBUTOR"]).nextStatus).toBeNull();
  });

  it("lets a pharmacy mark a stored lot delivered, and only that", () => {
    expect(allowed(lot(Status.Stored, PHARMACY), PHARMACY, ["RETAILER"])).toEqual(["canMarkDelivered"]);
    expect(allowed(lot(Status.Delivered, PHARMACY), PHARMACY, ["RETAILER"])).toEqual([]);
  });

  it("offers nothing for a lot the account does not hold", () => {
    expect(allowed(lot(Status.Stored, DISTRIBUTOR), OTHER_DISTRIBUTOR, ["DISTRIBUTOR"])).toEqual([]);
    expect(allowed(lot(Status.Created, MANUFACTURER), DISTRIBUTOR, ["MANUFACTURER"])).toEqual([]);
  });

  it("offers no custody action on a lot that is delivered, compromised or recalled", () => {
    for (const status of [Status.Delivered, Status.Compromised, Status.Recalled]) {
      expect(allowed(lot(status, DISTRIBUTOR), DISTRIBUTOR, ["DISTRIBUTOR", "MANUFACTURER", "RETAILER"])).toEqual([]);
    }
  });

  it("lets the regulator certify and recall every lot except a recalled one", () => {
    for (const status of [Status.Created, Status.InTransit, Status.Stored, Status.Delivered, Status.Compromised]) {
      expect(allowed(lot(status, PHARMACY), REGULATOR, ["REGULATOR"])).toEqual(["canCertify", "canRecall"]);
    }
    expect(allowed(lot(Status.Recalled, PHARMACY), REGULATOR, ["REGULATOR"])).toEqual([]);
  });

  it("offers nothing to an account without a role, even if it holds the lot", () => {
    expect(allowed(lot(Status.Stored, DISTRIBUTOR), DISTRIBUTOR, [])).toEqual([]);
  });

  it("compares addresses regardless of letter case", () => {
    const mixedCase = "0xAbCdEf0000000000000000000000000000000001";
    expect(sameAddress(mixedCase, mixedCase.toLowerCase())).toBe(true);
    expect(sameAddress(null, null)).toBe(false);
    expect(lotActions(lot(Status.Stored, mixedCase), mixedCase.toLowerCase(), ["RETAILER"]).canMarkDelivered).toBe(true);
  });
});

describe("eligibleRecipients", () => {
  const organizations = [
    { address: REGULATOR, roles: ["REGULATOR"] },
    { address: MANUFACTURER, roles: ["MANUFACTURER"] },
    { address: DISTRIBUTOR, roles: ["DISTRIBUTOR"] },
    { address: OTHER_DISTRIBUTOR, roles: ["DISTRIBUTOR"] },
    { address: PHARMACY, roles: ["RETAILER"] },
  ];
  const addresses = (list) => list.map((organization) => organization.address);

  it("offers a manufacturer the distributors only", () => {
    expect(addresses(eligibleRecipients(organizations, MANUFACTURER, ["MANUFACTURER"]))).toEqual([DISTRIBUTOR, OTHER_DISTRIBUTOR]);
  });

  it("offers a distributor the other distributors and the pharmacies, never itself", () => {
    expect(addresses(eligibleRecipients(organizations, DISTRIBUTOR, ["DISTRIBUTOR"]))).toEqual([OTHER_DISTRIBUTOR, PHARMACY]);
  });
});
