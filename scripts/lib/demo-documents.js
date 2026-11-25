// Synthetic off-chain documents for scripts/demo.js, and an in-memory stand-in
// for the IPFS node that would hold them.
//
// The registry stores only a DocumentRef (CID + keccak256 of the bytes) per
// document. The demo is a contract-level demo: it does not start an IPFS node
// or call a pinning service. So that the on-chain references are still real,
// it builds small JSON files, computes their true CIDs and hashes
// (scripts/lib/cid.js), and keeps the bytes in memory. The patient step can
// then "download" a file by its on-chain CID and check it against the
// on-chain hash, as the verify page does with a gateway (data flow 5).
//
// The three documents are modelled on the formats in docs/schemas/ (lot
// metadata, regulator certificate, sensor log). Every value is made up: no
// real product, organization or person appears in them.
import { documentRef } from "./cid.js";

const encoder = new TextEncoder();

// Spacing of the synthetic temperature readings, in seconds.
const READING_INTERVAL = 600;
const TWO_YEARS = 2 * 365 * 24 * 60 * 60;

/**
 * Holds "uploaded" files by CID. add() plays the role of pinning a file,
 * get() the role of an IPFS gateway.
 */
export class DocumentStore {
  #files = new Map();

  /**
   * Serialize a document, keep its bytes, and return the reference to store
   * on-chain. The bytes are fixed here once; hashing a re-serialized copy
   * later could give a different result (design decision O1).
   * @param {object} document a JSON-serializable document
   * @returns {{ cid: string, contentHash: string }}
   */
  add(document) {
    const bytes = encoder.encode(JSON.stringify(document, null, 2) + "\n");
    const reference = documentRef(bytes);
    this.#files.set(reference.cid, bytes);
    return reference;
  }

  /** @returns {Uint8Array | undefined} the bytes stored under `cid`, if any */
  get(cid) {
    return this.#files.get(cid);
  }
}

/**
 * Lot metadata, uploaded by the manufacturer before registerBatch. It cannot
 * name the lot ID, which the contract assigns during registration; chainId
 * and registry bind it to one deployment instead.
 */
export function lotMetadata({
  chainId,
  registry,
  productCode,
  lotNumber,
  manufactureDate,
  minTempTenthsC,
  maxTempTenthsC,
}) {
  return {
    schemaVersion: 1,
    type: "lot-metadata",
    chainId,
    registry,
    productCode,
    lotNumber,
    productName: "Demo vaccine (synthetic)",
    manufacturerName: "Demo Manufacturer",
    site: "Demo Plant",
    manufactureDate,
    expiryDate: manufactureDate + TWO_YEARS,
    storage: { minTenthsC: minTempTenthsC, maxTenthsC: maxTempTenthsC },
    attachments: [],
  };
}

/** Regulator certificate for one lot, uploaded before issueCertificate. */
export function regulatorCertificate({ chainId, registry, lotId, productHash, issuedAt }) {
  return {
    schemaVersion: 1,
    type: "regulator-certificate",
    chainId,
    registry,
    lotId,
    productHash,
    certificateNumber: `DEMO-CERT-${lotId}`,
    issuerName: "Demo Regulator",
    scope: "Batch release",
    statement: "Synthetic certificate for the contract demo: the lot is released for distribution.",
    issuedAt,
  };
}

/**
 * One sensor log: the given readings, taken every ten minutes, the last one
 * at `endedAt`.
 *
 * `excursion` is null for a routine log (anchorSensorLog). For a log that the
 * oracle reports with reportExcursion, pass `reportExcursion: true`: the
 * document then names its last reading as the excursion, and the demo passes
 * exactly that reading and time to the contract, so the on-chain event and
 * the file agree.
 */
export function sensorLog({
  chainId,
  registry,
  lotId,
  minTempTenthsC,
  maxTempTenthsC,
  endedAt,
  readingsTenthsC,
  reportExcursion = false,
}) {
  const startedAt = endedAt - (readingsTenthsC.length - 1) * READING_INTERVAL;
  const readings = readingsTenthsC.map((tenthsC, index) => ({ t: startedAt + index * READING_INTERVAL, tenthsC }));
  const last = readings[readings.length - 1];
  const degrees = (tenths) => (tenths / 10).toFixed(1);
  return {
    schemaVersion: 1,
    type: "sensor-log",
    chainId,
    registry,
    lotId,
    sensorId: "demo-sensor-1",
    scenario: reportExcursion ? "excursion" : "normal",
    range: { minTenthsC: minTempTenthsC, maxTenthsC: maxTempTenthsC },
    startedAt,
    endedAt,
    readings,
    excursion: reportExcursion
      ? {
          t: last.t,
          tenthsC: last.tenthsC,
          rule: `reading outside ${degrees(minTempTenthsC)} C to ${degrees(maxTempTenthsC)} C`,
        }
      : null,
  };
}
