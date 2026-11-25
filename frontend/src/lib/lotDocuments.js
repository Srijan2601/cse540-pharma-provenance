/**
 * The files of a lot, and what the verify page may conclude from each.
 *
 * A lot refers to its files in three places:
 *   - the record returned by verifyBatch: the lot metadata and the current certificate;
 *   - its events: every sensor log (the record itself keeps only the latest);
 *   - the lot metadata and the certificate, which list attachments.
 *
 * A file goes through two gates before any of its content is shown:
 *   1. its bytes must hash to the recorded fingerprint (done by chain/files.js);
 *   2. the bytes must be a valid document of the expected type that is about
 *      this lot (interpretDocument below).
 * Attachments are listed only from a document that passed both gates, because
 * a list read from an unverified file could point anywhere.
 *
 * Pure: the page passes in what it read and the results of the file checks.
 */

import { belongsToLot, readDocument } from "./documents.js";

/**
 * A stable key for a file reference.
 * @param {{ cid: string, contentHash: string }} ref
 * @returns {string}
 */
export function fileKey(ref) {
  return `${ref.cid}|${ref.contentHash}`;
}

/**
 * @typedef {object} LotDocument
 * @property {string} id            unique within the lot, for list keys
 * @property {"lot-metadata"|"regulator-certificate"|"sensor-log"|"attachment"} kind
 * @property {string} title         heading on the verify page, for example "Temperature log 2"
 * @property {string} label         how the file reads inside a sentence, with its article where it takes one:
 *                                  "the lot metadata", "sensor log 2"
 * @property {{ cid: string, contentHash: string }} ref
 * @property {number} [logIndex]    sensor logs: the log's number
 * @property {boolean} [isExcursion] sensor logs: true for the log reported with the excursion
 * @property {object} [attachment]  attachments: the entry from the document that lists the file
 *
 * @typedef {LotDocument & {
 *   status: "pending"|"match"|"mismatch"|"unavailable",
 *   reason: string|null,
 *   bytes: Uint8Array|null,
 *   document: any|null,
 *   contentProblem: string|null,
 *   contentInvalid: boolean
 * }} CheckedDocument
 *   `document` is the parsed content, present only when the bytes matched AND are a valid document
 *   for this lot. `contentProblem` says why matching bytes are not usable. `bytes` are the verified
 *   bytes of a matching file.
 */

/**
 * The files the chain itself refers to: lot metadata, current certificate, every sensor log.
 *
 * @param {{ metadata: object, certificate: object|null }} lot the record from verifyBatch
 * @param {{ sensorLogs: { index: number, cid: string, contentHash: string, isExcursion: boolean }[] }} history from replayHistory
 * @returns {LotDocument[]}
 */
export function listRecordedDocuments(lot, history) {
  const documents = [{ id: "metadata", kind: "lot-metadata", title: "Lot metadata", label: "the lot metadata", ref: lot.metadata }];
  if (lot.certificate !== null) {
    documents.push({
      id: "certificate",
      kind: "regulator-certificate",
      title: "Regulator certificate",
      label: "the regulator certificate",
      ref: lot.certificate,
    });
  }
  for (const log of history.sensorLogs) {
    documents.push({
      id: `sensor-log-${log.index}`,
      kind: "sensor-log",
      title: `Temperature log ${log.index}`,
      label: `sensor log ${log.index}`,
      ref: { cid: log.cid, contentHash: log.contentHash },
      logIndex: log.index,
      isExcursion: log.isExcursion,
    });
  }
  return documents;
}

/**
 * Combine a file with the result of its check and, for a document, read its content.
 *
 * @param {LotDocument} entry
 * @param {import("../chain/files.js").FileCheck|undefined} check undefined while the check is running
 * @param {{ chainId: number, registry: string, lotId: number, productHash: string }} lot what the chain says about the lot
 * @returns {CheckedDocument}
 */
export function interpretDocument(entry, check, lot) {
  const checked = {
    ...entry,
    status: check?.status ?? "pending",
    reason: check?.reason ?? null,
    bytes: null,
    document: null,
    contentProblem: null,
    contentInvalid: false,
  };
  if (check?.status !== "match") return checked;

  checked.bytes = check.bytes;
  // An attachment is an arbitrary file; there is nothing to parse.
  if (entry.kind === "attachment") return checked;

  const { document, problem } = readDocument(check.bytes, entry.kind);
  const contentProblem = problem ?? belongsToLot(document, lot);
  if (contentProblem === null) checked.document = document;
  else {
    checked.contentProblem = contentProblem;
    checked.contentInvalid = true;
  }
  return checked;
}

/**
 * The attachments listed by documents that passed both gates.
 *
 * @param {CheckedDocument[]} documents interpreted lot metadata and certificate
 * @returns {LotDocument[]}
 */
export function listAttachments(documents) {
  return documents.flatMap((owner) =>
    (owner.document?.attachments ?? []).map((attachment, position) => ({
      id: `${owner.id}-attachment-${position}`,
      kind: "attachment",
      title: attachment.name,
      // Quoted, because a file name is free text chosen by another organization.
      label: `the attachment "${attachment.name}"`,
      ref: { cid: attachment.cid, contentHash: attachment.contentHash },
      attachment,
    })),
  );
}
