/**
 * Tests of the verdict rules: which banner a lot gets, in which order the
 * rules win, and which neutral notes accompany it.
 */

import { describe, expect, it } from "vitest";

import { Status } from "./constants.js";
import { computeVerdict, statusInWords } from "./verdict.js";

const CERTIFICATE = { cid: "bafk-certificate", contentHash: `0x${"11".repeat(32)}` };
const NO_EVENTS = { excursion: null, recall: null };

/**
 * A lot record with sensible defaults; each test overrides what it is about.
 * @param {object} [overrides]
 */
function lot(overrides = {}) {
  return {
    status: Status.Delivered,
    pendingCustodian: null,
    minTempTenthsC: 20,
    maxTempTenthsC: 80,
    certificate: CERTIFICATE,
    ...overrides,
  };
}

const matching = (label) => ({ label, status: "match" });
const ALL_MATCH = [matching("the lot metadata"), matching("the regulator certificate"), matching("sensor log 1")];

describe("computeVerdict", () => {
  it("verifies a delivered, certified lot whose files all match", () => {
    expect(computeVerdict({ lot: lot(), history: NO_EVENTS, documents: ALL_MATCH, holderRoles: ["RETAILER"] })).toEqual({
      level: "verified",
      title: "Record verified",
      detail: "Delivered by the pharmacy.",
      notes: [],
    });
  });

  it("tells a recalled lot apart with the regulator's reason", () => {
    const verdict = computeVerdict({
      lot: lot({ status: Status.Recalled }),
      history: { excursion: null, recall: { reason: "Contamination found at the plant" } },
      documents: ALL_MATCH,
    });
    expect(verdict.level).toBe("danger");
    expect(verdict.title).toBe("Do not use: recalled by the regulator");
    expect(verdict.detail).toContain("Contamination found at the plant");
  });

  it("tells a compromised lot apart with the reading and the allowed range", () => {
    const verdict = computeVerdict({
      lot: lot({ status: Status.Compromised }),
      history: { excursion: { readingTenthsC: 94 }, recall: null },
      documents: ALL_MATCH,
    });
    expect(verdict.level).toBe("danger");
    expect(verdict.title).toBe("Do not use: a temperature excursion was recorded");
    expect(verdict.detail).toBe("A reading of 9.4 °C was reported. The allowed range is 2.0 °C to 8.0 °C.");
  });

  it("lets a recall win over an earlier excursion", () => {
    const verdict = computeVerdict({
      lot: lot({ status: Status.Recalled }),
      history: { excursion: { readingTenthsC: 94 }, recall: { reason: "Cold chain broken" } },
      documents: ALL_MATCH,
    });
    expect(verdict.title).toBe("Do not use: recalled by the regulator");
  });

  it("reports a file that does not match its fingerprint", () => {
    const verdict = computeVerdict({
      lot: lot(),
      history: NO_EVENTS,
      documents: [{ label: "the lot metadata", status: "mismatch" }, matching("the regulator certificate")],
    });
    expect(verdict.level).toBe("problem");
    expect(verdict.title).toBe("Record problem: a file does not match its fingerprint");
    expect(verdict.detail).toBe("The lot metadata is not the file that was recorded on the blockchain. Do not rely on this record.");
  });

  it("reports a mismatch at once, even while other files are still being checked", () => {
    const verdict = computeVerdict({
      lot: lot(),
      history: NO_EVENTS,
      documents: [{ label: "the lot metadata", status: "mismatch" }, { label: "sensor log 1", status: "pending" }],
    });
    expect(verdict.level).toBe("problem");
  });

  it("does not hide a recall behind a mismatching file, but mentions the file", () => {
    const verdict = computeVerdict({
      lot: lot({ status: Status.Recalled }),
      history: { excursion: null, recall: { reason: "Label error" } },
      documents: [{ label: "sensor log 2", status: "mismatch" }],
    });
    expect(verdict.level).toBe("danger");
    expect(verdict.notes).toEqual(["In addition, sensor log 2 does not match the recorded fingerprint."]);
  });

  it("waits for the file checks before calling a record verified", () => {
    const verdict = computeVerdict({
      lot: lot(),
      history: NO_EVENTS,
      documents: [matching("the lot metadata"), { label: "sensor log 1", status: "pending" }],
    });
    expect(verdict.level).toBe("checking");
  });

  it("adds a neutral note when the lot has no regulator certificate", () => {
    const verdict = computeVerdict({
      lot: lot({ status: Status.Stored, certificate: null }),
      history: NO_EVENTS,
      documents: [matching("the lot metadata")],
      holderRoles: ["RETAILER"],
    });
    expect(verdict.level).toBe("verified");
    expect(verdict.detail).toBe("Stored at the pharmacy.");
    expect(verdict.notes).toEqual(["No regulator certificate has been issued for this lot."]);
  });

  it("adds a neutral note when files could not be fetched, without failing the record", () => {
    const verdict = computeVerdict({
      lot: lot(),
      history: NO_EVENTS,
      documents: [matching("the lot metadata"), { label: "sensor log 1", status: "unavailable" }, { label: "sensor log 2", status: "unavailable" }],
    });
    expect(verdict.level).toBe("verified");
    expect(verdict.notes).toEqual(["Sensor log 1 and sensor log 2 could not be fetched, so they were not checked."]);
  });

  it("says that only the blockchain record was verified when no file could be fetched", () => {
    const verdict = computeVerdict({
      lot: lot({ status: Status.Stored, certificate: null }),
      history: NO_EVENTS,
      documents: [{ label: "the lot metadata", status: "unavailable" }, { label: "sensor log 1", status: "unavailable" }],
      holderRoles: ["RETAILER"],
    });
    expect(verdict.level).toBe("verified");
    expect(verdict.title).toBe("Record verified");
    // The note that limits what "verified" covers comes before the certificate note.
    expect(verdict.notes).toEqual([
      "Only the blockchain record was verified. The lot metadata and sensor log 1 could not be fetched, so they were not checked. " +
        "The page keeps trying.",
      "No regulator certificate has been issued for this lot.",
    ]);
  });

  it("notes a file that matches but is not a valid document for the lot", () => {
    const verdict = computeVerdict({
      lot: lot(),
      history: NO_EVENTS,
      documents: [{ label: "the lot metadata", status: "match", contentInvalid: true }],
    });
    expect(verdict.notes).toContain(
      "A file matches its fingerprint but is not a valid document for this lot, so its details are not shown.",
    );
  });

  it("notes a history that does not add up to the current state", () => {
    const verdict = computeVerdict({ lot: lot(), history: NO_EVENTS, documents: ALL_MATCH, historyComplete: false });
    expect(verdict.notes).toContain("The history below does not add up to the lot's current state, so it may be incomplete.");
  });
});

describe("statusInWords", () => {
  it("describes every usable status", () => {
    expect(statusInWords({ status: Status.Created, pendingCustodian: null })).toBe(
      "Registered by the manufacturer. It has not been shipped yet.",
    );
    expect(statusInWords({ status: Status.InTransit, pendingCustodian: "0xabc" })).toBe(
      "In transit. A hand-off has been started and is waiting for the recipient to accept it.",
    );
    expect(statusInWords({ status: Status.InTransit, pendingCustodian: null })).toBe("In transit with a distributor.");
    expect(statusInWords({ status: Status.Stored, pendingCustodian: null }, ["DISTRIBUTOR"])).toBe("Stored at a distributor.");
    expect(statusInWords({ status: Status.Stored, pendingCustodian: null })).toBe("In storage.");
    expect(statusInWords({ status: Status.Delivered, pendingCustodian: null })).toBe("Delivered by the pharmacy.");
  });
});
