/**
 * The verdict banner of the patient verify page: one answer in plain words.
 *
 * Rules, first match wins:
 *
 *   1. Recalled                         -> "Do not use: recalled by the regulator" (with the reason)
 *   2. Compromised                      -> "Do not use: a temperature excursion was recorded"
 *                                          (with the reading and the allowed range)
 *   3. a file differs from its hash     -> "Record problem: a file does not match its fingerprint"
 *   4. a file check is still running    -> "Checking the record"
 *   5. otherwise                        -> "Record verified", with the lot's status in words
 *
 * The first two come straight from the contract and need no file, so they are
 * shown even while files are still loading. Things a patient should know but
 * that are not a failure (no regulator certificate yet, a file the gateway
 * could not deliver) are returned as separate neutral notes. Files that could
 * not be fetched come first among the notes, because they limit what "Record
 * verified" covers. When none of the files could be fetched, the note says
 * plainly that only the blockchain record was checked, so "verified" is not
 * read as covering the product details.
 *
 * Pure: the page passes in what it read; nothing is fetched here.
 */

import { Status } from "./constants.js";
import { formatTemperature, formatTemperatureRange } from "./format.js";

/**
 * @typedef {"checking"|"verified"|"problem"|"danger"} VerdictLevel
 *
 * @typedef {object} Verdict
 * @property {VerdictLevel} level  drives the banner's icon and colour
 * @property {string} title        the answer, for example "Record verified"
 * @property {string} detail       one sentence of explanation
 * @property {string[]} notes      neutral remarks shown under the banner; may be empty
 *
 * @typedef {object} DocumentCheck
 * @property {string} label                                        what the file is, as it reads inside a sentence: "the lot metadata", "sensor log 2"
 * @property {"pending"|"match"|"mismatch"|"unavailable"} status   result of comparing its bytes with the recorded hash
 * @property {boolean} [contentInvalid]                            true when the bytes match but are not a valid document for this lot
 */

/**
 * Decide the verdict for a lot.
 *
 * @param {object} input
 * @param {{ status: number, pendingCustodian: string|null, minTempTenthsC: number, maxTempTenthsC: number,
 *           certificate: object|null }} input.lot    the record returned by verifyBatch
 * @param {{ excursion: { readingTenthsC: number }|null, recall: { reason: string }|null }} input.history from replayHistory
 * @param {DocumentCheck[]} input.documents           one entry per file the page checks
 * @param {string[]} [input.holderRoles]              role keys the current holder has on-chain
 * @param {boolean} [input.historyComplete]           false when the events do not add up to the lot's current state
 * @returns {Verdict}
 */
export function computeVerdict({ lot, history, documents, holderRoles = [], historyComplete = true }) {
  const mismatched = documents.filter((document) => document.status === "mismatch");
  const unavailable = documents.filter((document) => document.status === "unavailable");
  // A recalled or compromised lot is unusable whatever its files say, but a changed file is still worth telling.
  const mismatchNote =
    mismatched.length > 0
      ? [`In addition, ${listLabels(mismatched)} ${mismatched.length === 1 ? "does" : "do"} not match the recorded fingerprint.`]
      : [];

  if (lot.status === Status.Recalled) {
    return {
      level: "danger",
      title: "Do not use: recalled by the regulator",
      detail: history.recall ? `Reason given by the regulator: ${history.recall.reason}` : "The regulator recalled this lot.",
      notes: mismatchNote,
    };
  }

  if (lot.status === Status.Compromised) {
    const range = formatTemperatureRange(lot.minTempTenthsC, lot.maxTempTenthsC);
    return {
      level: "danger",
      title: "Do not use: a temperature excursion was recorded",
      detail: history.excursion
        ? `A reading of ${formatTemperature(history.excursion.readingTenthsC)} was reported. The allowed range is ${range}.`
        : `A reading outside the allowed range of ${range} was reported.`,
      notes: mismatchNote,
    };
  }

  const notes = [];
  if (unavailable.length > 0) {
    const notChecked =
      `${capitalize(listLabels(unavailable))} could not be fetched, so ${unavailable.length === 1 ? "it was" : "they were"} not checked.`;
    notes.push(
      unavailable.length === documents.length
        ? `Only the blockchain record was verified. ${notChecked} The page keeps trying.`
        : notChecked,
    );
  }
  if (lot.certificate === null) notes.push("No regulator certificate has been issued for this lot.");
  if (documents.some((document) => document.contentInvalid)) {
    notes.push("A file matches its fingerprint but is not a valid document for this lot, so its details are not shown.");
  }
  if (!historyComplete) {
    notes.push("The history below does not add up to the lot's current state, so it may be incomplete.");
  }

  if (mismatched.length > 0) {
    return {
      level: "problem",
      title: "Record problem: a file does not match its fingerprint",
      detail:
        `${capitalize(listLabels(mismatched))} ${mismatched.length === 1 ? "is" : "are"} not the file that was recorded on the ` +
        "blockchain. Do not rely on this record.",
      notes,
    };
  }

  if (documents.some((document) => document.status === "pending")) {
    return { level: "checking", title: "Checking the record", detail: "Comparing each file with its fingerprint on the blockchain.", notes: [] };
  }

  return { level: "verified", title: "Record verified", detail: statusInWords(lot, holderRoles), notes };
}

/**
 * The status of a usable lot as a sentence fragment for the verdict banner.
 *
 * @param {{ status: number, pendingCustodian: string|null }} lot
 * @param {string[]} holderRoles role keys of the current holder
 * @returns {string} for example "Delivered by the pharmacy."
 */
export function statusInWords(lot, holderRoles = []) {
  switch (lot.status) {
    case Status.Created:
      return "Registered by the manufacturer. It has not been shipped yet.";
    case Status.InTransit:
      return lot.pendingCustodian
        ? "In transit. A hand-off has been started and is waiting for the recipient to accept it."
        : "In transit with a distributor.";
    case Status.Stored:
      if (holderRoles.includes("RETAILER")) return "Stored at the pharmacy.";
      if (holderRoles.includes("DISTRIBUTOR")) return "Stored at a distributor.";
      return "In storage.";
    case Status.Delivered:
      return "Delivered by the pharmacy.";
    default:
      return "";
  }
}

/**
 * Join document labels into a phrase: "the lot metadata", "the lot metadata, sensor log 1 and sensor log 2".
 * @param {DocumentCheck[]} documents at least one
 * @returns {string}
 */
function listLabels(documents) {
  const labels = documents.map((document) => document.label);
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * @param {string} text
 * @returns {string} the text with its first letter in upper case
 */
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
