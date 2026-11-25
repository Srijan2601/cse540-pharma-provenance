/**
 * Tests of the history reducer: scripted event sequences must add up to the
 * status and custodian the contract would hold, and to the right timeline.
 *
 * The sequences follow the state machine documented in
 * contracts/interfaces/IProvenanceRegistry.sol (the Status enum comment).
 */

import { describe, expect, it } from "vitest";

import { Status } from "./constants.js";
import { describeEntry, partyName, replayHistory } from "./history.js";

const MANUFACTURER = "0x1000000000000000000000000000000000000001";
const DISTRIBUTOR = "0x2000000000000000000000000000000000000002";
const OTHER_DISTRIBUTOR = "0x3000000000000000000000000000000000000003";
const PHARMACY = "0x4000000000000000000000000000000000000004";
const REGULATOR = "0x5000000000000000000000000000000000000005";
const HASH = `0x${"ab".repeat(32)}`;

/**
 * Write an event sequence compactly: every event gets its own block, one
 * minute after the previous one, the way a local chain mines them.
 * @param {[string, Record<string, any>][]} steps event name and arguments, in order
 * @returns {import("./history.js").LotEvent[]}
 */
function script(steps) {
  return steps.map(([name, args], position) => ({
    name,
    args: { batchId: 1, ...args },
    blockNumber: 10 + position,
    logIndex: 0,
    timestamp: 1_800_000_000 + position * 60,
  }));
}

const registered = ["BatchRegistered", { manufacturer: MANUFACTURER, productHash: HASH, metadataCid: "bafk-metadata" }];
const offered = (from, to) => ["TransferInitiated", { from, to }];
const accepted = (from, to) => ["CustodyTransferred", { from, to }];
const cancelled = (from, to) => ["TransferCancelled", { from, to }];
const statusChanged = (by, previousStatus, newStatus) => ["StatusUpdated", { by, previousStatus, newStatus }];
const logAnchored = (logIndex) => ["SensorLogAnchored", { logIndex, cid: `bafk-log-${logIndex}`, contentHash: HASH }];

describe("replayHistory", () => {
  it("returns an empty history for no events", () => {
    const history = replayHistory([]);
    expect(history.entries).toEqual([]);
    expect(history.status).toBeNull();
    expect(history.custodian).toBeNull();
  });

  it("follows the full journey from the factory to the patient", () => {
    const history = replayHistory(
      script([
        registered,
        offered(MANUFACTURER, DISTRIBUTOR),
        accepted(MANUFACTURER, DISTRIBUTOR),
        logAnchored(1),
        statusChanged(DISTRIBUTOR, Status.Stored, Status.InTransit),
        statusChanged(DISTRIBUTOR, Status.InTransit, Status.Stored),
        offered(DISTRIBUTOR, PHARMACY),
        accepted(DISTRIBUTOR, PHARMACY),
        logAnchored(2),
        ["CertificateIssued", { regulator: REGULATOR, cid: "bafk-certificate", contentHash: HASH }],
        statusChanged(PHARMACY, Status.Stored, Status.Delivered),
      ]),
    );

    expect(history.status).toBe(Status.Delivered);
    expect(history.manufacturer).toBe(MANUFACTURER);
    expect(history.custodian).toBe(PHARMACY);
    expect(history.pendingCustodian).toBeNull();
    expect(history.entries.map((entry) => entry.statusAfter)).toEqual([
      Status.Created,
      Status.InTransit,
      Status.Stored,
      Status.Stored,
      Status.InTransit,
      Status.Stored,
      Status.InTransit,
      Status.Stored,
      Status.Stored,
      Status.Stored,
      Status.Delivered,
    ]);
    expect(history.sensorLogs.map((log) => log.index)).toEqual([1, 2]);
    expect(history.certificates).toHaveLength(1);
    expect(history.excursion).toBeNull();
    expect(history.recall).toBeNull();
  });

  it("keeps custody with the sender while a hand-off is open", () => {
    const history = replayHistory(script([registered, offered(MANUFACTURER, DISTRIBUTOR)]));
    expect(history.status).toBe(Status.InTransit);
    expect(history.custodian).toBe(MANUFACTURER);
    expect(history.pendingCustodian).toBe(DISTRIBUTOR);
  });

  it("returns a cancelled hand-off to Created when the lot never left the factory", () => {
    const history = replayHistory(script([registered, offered(MANUFACTURER, OTHER_DISTRIBUTOR), cancelled(MANUFACTURER, OTHER_DISTRIBUTOR)]));
    expect(history.status).toBe(Status.Created);
    expect(history.custodian).toBe(MANUFACTURER);
    expect(history.pendingCustodian).toBeNull();
  });

  it("returns a cancelled hand-off to Stored when a distributor opened it", () => {
    const history = replayHistory(
      script([
        registered,
        offered(MANUFACTURER, DISTRIBUTOR),
        accepted(MANUFACTURER, DISTRIBUTOR),
        offered(DISTRIBUTOR, PHARMACY),
        cancelled(DISTRIBUTOR, PHARMACY),
      ]),
    );
    expect(history.status).toBe(Status.Stored);
    expect(history.custodian).toBe(DISTRIBUTOR);
    expect(history.pendingCustodian).toBeNull();
  });

  it("marks the lot compromised, closes the open hand-off and records the excursion log", () => {
    const history = replayHistory(
      script([
        registered,
        offered(MANUFACTURER, DISTRIBUTOR),
        accepted(MANUFACTURER, DISTRIBUTOR),
        logAnchored(1),
        offered(DISTRIBUTOR, PHARMACY),
        [
          "ExcursionReported",
          { logIndex: 2, readingTenthsC: 94, observedAt: 1_800_000_200, logCid: "bafk-excursion", logContentHash: HASH },
        ],
      ]),
    );
    expect(history.status).toBe(Status.Compromised);
    expect(history.custodian).toBe(DISTRIBUTOR);
    expect(history.pendingCustodian).toBeNull();
    expect(history.excursion).toMatchObject({ readingTenthsC: 94, observedAt: 1_800_000_200, logIndex: 2 });
    expect(history.sensorLogs).toEqual([
      expect.objectContaining({ index: 1, cid: "bafk-log-1", isExcursion: false }),
      expect.objectContaining({ index: 2, cid: "bafk-excursion", isExcursion: true }),
    ]);
  });

  it("makes a recall final, even for a delivered lot, and keeps the reason", () => {
    const history = replayHistory(
      script([
        registered,
        offered(MANUFACTURER, DISTRIBUTOR),
        accepted(MANUFACTURER, DISTRIBUTOR),
        offered(DISTRIBUTOR, PHARMACY),
        accepted(DISTRIBUTOR, PHARMACY),
        statusChanged(PHARMACY, Status.Stored, Status.Delivered),
        ["BatchRecalled", { regulator: REGULATOR, reason: "Particles found in retained samples" }],
      ]),
    );
    expect(history.status).toBe(Status.Recalled);
    expect(history.custodian).toBe(PHARMACY);
    expect(history.recall).toMatchObject({ regulator: REGULATOR, reason: "Particles found in retained samples" });
  });

  it("keeps every certificate, the newest last", () => {
    const history = replayHistory(
      script([
        registered,
        ["CertificateIssued", { regulator: REGULATOR, cid: "bafk-first", contentHash: HASH }],
        ["CertificateIssued", { regulator: REGULATOR, cid: "bafk-second", contentHash: HASH }],
      ]),
    );
    expect(history.certificates.map((certificate) => certificate.cid)).toEqual(["bafk-first", "bafk-second"]);
    expect(history.status).toBe(Status.Created);
  });

  it("orders events by block and log index, whatever order they arrive in", () => {
    const events = script([registered, offered(MANUFACTURER, DISTRIBUTOR), accepted(MANUFACTURER, DISTRIBUTOR)]);
    const history = replayHistory([events[2], events[0], events[1]]);
    expect(history.entries.map((entry) => entry.type)).toEqual(["BatchRegistered", "TransferInitiated", "CustodyTransferred"]);
    expect(history.custodian).toBe(DISTRIBUTOR);
  });

  it("orders two events of the same block by their log index", () => {
    const [first, second] = script([registered, offered(MANUFACTURER, DISTRIBUTOR)]);
    const history = replayHistory([
      { ...second, blockNumber: 10, logIndex: 1 },
      { ...first, blockNumber: 10, logIndex: 0 },
    ]);
    expect(history.status).toBe(Status.InTransit);
  });

  it("ignores events that are not part of a lot's history", () => {
    const history = replayHistory(script([registered, ["RoleGranted", { role: HASH, account: DISTRIBUTOR, sender: REGULATOR }]]));
    expect(history.entries).toHaveLength(1);
    expect(history.status).toBe(Status.Created);
  });
});

describe("describeEntry", () => {
  const rolesByAddress = { [DISTRIBUTOR]: ["DISTRIBUTOR"], [OTHER_DISTRIBUTOR]: ["DISTRIBUTOR"], [PHARMACY]: ["RETAILER"] };
  const sentences = (steps) =>
    replayHistory(script(steps)).entries.map((entry) => describeEntry(entry, rolesByAddress));

  it("names the manufacturer, the distributor and the pharmacy by role", () => {
    const [registration, firstOffer, firstAccept, secondOffer, secondAccept, delivery] = sentences([
      registered,
      offered(MANUFACTURER, DISTRIBUTOR),
      accepted(MANUFACTURER, DISTRIBUTOR),
      offered(DISTRIBUTOR, PHARMACY),
      accepted(DISTRIBUTOR, PHARMACY),
      statusChanged(PHARMACY, Status.Stored, Status.Delivered),
    ]);
    expect(registration).toEqual({
      title: "Lot registered",
      sentence: "Manufacturer 0x1000…0001 registered the lot. Status: created.",
      isWarning: false,
    });
    expect(firstOffer.sentence).toBe("Manufacturer 0x1000…0001 offered the lot to Distributor 0x2000…0002. Status: in transit.");
    expect(firstAccept.sentence).toBe(
      "Distributor 0x2000…0002 accepted the lot from Manufacturer 0x1000…0001 and now holds it. Status: stored.",
    );
    expect(secondOffer.sentence).toBe("Distributor 0x2000…0002 offered the lot to Pharmacy 0x4000…0004. Status: in transit.");
    expect(secondAccept.sentence).toBe(
      "Pharmacy 0x4000…0004 accepted the lot from Distributor 0x2000…0002 and now holds it. Status: stored.",
    );
    expect(delivery).toMatchObject({ title: "Lot delivered", sentence: "Pharmacy 0x4000…0004 marked the lot as delivered." });
  });

  it("says which status a cancelled hand-off went back to", () => {
    const [, , cancellation] = sentences([registered, offered(MANUFACTURER, OTHER_DISTRIBUTOR), cancelled(MANUFACTURER, OTHER_DISTRIBUTOR)]);
    expect(cancellation.sentence).toBe(
      "Manufacturer 0x1000…0001 cancelled the hand-off to Distributor 0x3000…0003. Status: back to created.",
    );
  });

  it("describes a status update in words", () => {
    const entries = sentences([
      registered,
      offered(MANUFACTURER, DISTRIBUTOR),
      accepted(MANUFACTURER, DISTRIBUTOR),
      statusChanged(DISTRIBUTOR, Status.Stored, Status.InTransit),
    ]);
    expect(entries.at(-1).sentence).toBe("Distributor 0x2000…0002 changed the status from stored to in transit.");
  });

  it("flags an excursion and a recall as warnings and quotes the reading and the reason", () => {
    const entries = sentences([
      registered,
      ["ExcursionReported", { logIndex: 1, readingTenthsC: 94, observedAt: 1_800_000_000, logCid: "bafk", logContentHash: HASH }],
      ["BatchRecalled", { regulator: REGULATOR, reason: "Cold chain broken" }],
    ]);
    expect(entries[1]).toMatchObject({ title: "Temperature excursion reported", isWarning: true });
    expect(entries[1].sentence).toContain("9.4 °C");
    expect(entries[2]).toEqual({
      title: "Lot recalled",
      sentence: "Regulator 0x5000…0005 recalled the lot. Reason: Cold chain broken",
      isWarning: true,
    });
  });
});

describe("partyName", () => {
  it("falls back to a neutral word when the recipient's role is not known", () => {
    expect(partyName(PHARMACY, null, {})).toBe("Organization 0x4000…0004");
  });

  it("prefers the role the contract's rules guarantee over the current on-chain roles", () => {
    expect(partyName(MANUFACTURER, "MANUFACTURER", { [MANUFACTURER]: ["DISTRIBUTOR"] })).toBe("Manufacturer 0x1000…0001");
  });
});
