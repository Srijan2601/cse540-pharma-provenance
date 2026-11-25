/**
 * The off-chain documents (lot metadata, regulator certificate, sensor log)
 * as the browser builds and reads them.
 *
 * Nothing about the formats is defined here. The JSON Schemas come from
 * docs/schemas/ and the validator and builders from oracle/src/documents/, the
 * same files the oracle and its tests use, so the dApp cannot drift from them.
 * This module only wires them together and adds the two things a reader needs:
 *
 *   readDocument     bytes -> a document that passed its schema, or a reason
 *   belongsToLot     is this (valid) document really about the lot on screen?
 *
 * Both matter because a file's fingerprint only proves that its bytes are the
 * ones that were anchored. It does not prove they are a well-formed document,
 * nor that the document is about this lot: an anchored reference could point
 * at a genuine file that belongs to another lot or another registry.
 */

import commonSchema from "@schemas/common.schema.json";
import lotMetadataSchema from "@schemas/lot-metadata.schema.json";
import regulatorCertificateSchema from "@schemas/regulator-certificate.schema.json";
import sensorLogSchema from "@schemas/sensor-log.schema.json";

import { buildAttachment, computeProductHash, createDocumentBuilders } from "@oracle/documents/builders.js";
import { decodeDocument } from "@oracle/documents/serialize.js";
import { createDocumentValidator } from "@oracle/documents/validator.js";

const validator = createDocumentValidator([commonSchema, lotMetadataSchema, regulatorCertificateSchema, sensorLogSchema]);

/**
 * buildLotMetadata, buildRegulatorCertificate and buildSensorLog. Each returns
 * { document, bytes, contentHash }; `bytes` are uploaded exactly as returned.
 */
export const documentBuilders = createDocumentBuilders(validator);

export { buildAttachment, computeProductHash };

/**
 * Decode downloaded bytes and validate them against the schema of the expected document type.
 *
 * @param {Uint8Array} bytes the bytes exactly as fetched (and already checked against their hash)
 * @param {"lot-metadata"|"regulator-certificate"|"sensor-log"} expectedType
 * @returns {{ document: any, problem: null } | { document: null, problem: string }}
 *   Never throws: a malformed file is an expected outcome when reading untrusted content.
 */
export function readDocument(bytes, expectedType) {
  let parsed;
  try {
    parsed = decodeDocument(bytes);
  } catch {
    return { document: null, problem: "The file is not valid JSON text." };
  }
  const result = validator.validate(parsed, expectedType);
  if (!result.valid) {
    const first = result.errors[0];
    return { document: null, problem: `The file is not a valid ${expectedType} document (${first.path} ${first.message}).` };
  }
  return { document: parsed, problem: null };
}

/**
 * Check that a valid document is about the lot being verified: the chain,
 * registry and lot checks of step 5 of "Verifying a document by hand" in
 * docs/schemas/README.md (lot metadata, which has no lotId, is matched by its
 * product hash). The step's comparison of a sensor log's excursion with the
 * ExcursionReported event is not made here.
 *
 * @param {any} document a document that passed readDocument
 * @param {{ chainId: number, registry: string, lotId: number, productHash: string }} lot what the chain says
 * @returns {string|null} null when it belongs to the lot, otherwise the reason it does not
 */
export function belongsToLot(document, lot) {
  if (document.chainId !== lot.chainId || document.registry.toLowerCase() !== lot.registry.toLowerCase()) {
    return "The file was written for a different registry.";
  }
  if (document.type === "lot-metadata") {
    // Lot metadata is written before the lot has an id, so it is tied to the lot by the product hash instead.
    return computeProductHash(document.productCode, document.lotNumber) === lot.productHash.toLowerCase()
      ? null
      : "The product code and lot number in the file do not match the lot's on-chain product hash.";
  }
  if (document.lotId !== lot.lotId) return "The file was written for a different lot.";
  if (document.type === "regulator-certificate" && document.productHash !== lot.productHash.toLowerCase()) {
    return "The certificate names a different product.";
  }
  return null;
}
