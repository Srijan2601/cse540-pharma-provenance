/**
 * From what a person types in a dashboard form to what goes into a document
 * and into the contract call.
 *
 * Two steps per form, both pure so they can be unit tested without a browser:
 *
 *   validate...  checks the typed values and returns one plain-language
 *                message per field that is wrong (an empty object means the
 *                form is fine). The same rules exist in the JSON Schemas and in
 *                the contract; checking them here first means a person reads
 *                "the lowest temperature must be below the highest" next to
 *                the field instead of a schema path or a revert.
 *   build...     converts a validated form into the fields of the shared
 *                document builder (see lib/documents.js) and the arguments of
 *                the contract function.
 */

import { computeProductHash } from "./documents.js";
import { dateInputToUnix, parseTemperature } from "./format.js";

/** Length limits of the JSON Schemas in docs/schemas/. */
const MAX_CODE_LENGTH = 64;
const MAX_TEXT_LENGTH = 200;
const MAX_STATEMENT_LENGTH = 2000;
const MAX_FILE_NAME_LENGTH = 128;

/** Bytes the encryption envelope adds to a file: version byte, 12-byte IV, 16-byte tag. */
const ENVELOPE_OVERHEAD_BYTES = 29;

/** The schema's pattern for a media type; anything else is recorded as a generic binary file. */
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** A new, empty "Register a lot" form. The range is prefilled with the usual refrigerated range. */
export const EMPTY_LOT_FORM = Object.freeze({
  productCode: "",
  productName: "",
  lotNumber: "",
  manufacturerName: "",
  site: "",
  manufactureDate: "",
  expiryDate: "",
  minTemp: "2.0",
  maxTemp: "8.0",
});

/** A new, empty "Issue certificate" form. */
export const EMPTY_CERTIFICATE_FORM = Object.freeze({ certificateNumber: "", issuerName: "", scope: "", statement: "" });

/**
 * Check the "Register a lot" form.
 *
 * @param {typeof EMPTY_LOT_FORM} form the typed values (all strings)
 * @param {{ today: string }} context  today's date as "YYYY-MM-DD" in the person's time zone
 * @returns {Record<string, string>} field name -> message; empty when the form is valid
 */
export function validateLotForm(form, { today }) {
  const errors = {};
  requireText(errors, form, "productCode", "product code", MAX_CODE_LENGTH);
  requireText(errors, form, "lotNumber", "lot number", MAX_CODE_LENGTH);
  requireText(errors, form, "productName", "product name", MAX_TEXT_LENGTH);
  requireText(errors, form, "manufacturerName", "manufacturer name", MAX_TEXT_LENGTH);
  requireText(errors, form, "site", "manufacturing site", MAX_TEXT_LENGTH);

  const manufactured = dateInputToUnix(form.manufactureDate);
  const expires = dateInputToUnix(form.expiryDate);
  if (manufactured === null) {
    errors.manufactureDate = "Enter the manufacture date.";
  } else if (form.manufactureDate > today) {
    // "YYYY-MM-DD" strings sort like the dates they name, so a plain comparison is enough.
    errors.manufactureDate = "The manufacture date cannot be in the future.";
  }
  if (expires === null) {
    errors.expiryDate = "Enter the expiry date.";
  } else if (manufactured !== null && expires <= manufactured) {
    errors.expiryDate = "The expiry date must be after the manufacture date.";
  }

  const min = parseTemperature(form.minTemp);
  const max = parseTemperature(form.maxTemp);
  if (min === null) errors.minTemp = "Enter the lowest allowed temperature in °C, with at most one decimal (for example 2.0).";
  if (max === null) errors.maxTemp = "Enter the highest allowed temperature in °C, with at most one decimal (for example 8.0).";
  if (min !== null && max !== null && min >= max) {
    errors.minTemp = "The lowest allowed temperature must be below the highest.";
  }
  return errors;
}

/**
 * The manufacture date to record for a picked calendar day.
 *
 * A calendar day is stored as midnight UTC of that day. The contract rejects a
 * manufacture date later than the block's timestamp, and midnight UTC of
 * "today" can still lie ahead of the chain's clock: for anyone east of
 * Greenwich during their morning, or when the chain's latest block is older
 * than the day. In that case the chain's current time is recorded instead,
 * which is the latest moment the contract accepts and still "today" for the
 * person who picked it.
 *
 * @param {number} pickedMidnightUtc midnight UTC of the picked day, Unix seconds
 * @param {number} chainNow          timestamp of the chain's latest block, Unix seconds
 * @returns {number} Unix seconds, never later than `chainNow`
 */
export function resolveManufactureDate(pickedMidnightUtc, chainNow) {
  return Math.min(pickedMidnightUtc, chainNow);
}

/**
 * Convert a valid "Register a lot" form into the registerBatch arguments and the lot-metadata fields.
 *
 * @param {typeof EMPTY_LOT_FORM} form a form for which validateLotForm returned no errors
 * @param {object} context
 * @param {number} context.chainId     chain the registry is on
 * @param {string} context.registry    address of the registry
 * @param {number} context.chainNow    timestamp of the chain's latest block
 * @param {object[]} [context.attachments] attachment entries of files already uploaded (see describeAttachment)
 * @returns {{ productHash: string, manufactureDate: number, minTempTenthsC: number, maxTempTenthsC: number,
 *             metadataFields: object }}
 *   `metadataFields` goes to documentBuilders.buildLotMetadata; the other values are the contract arguments.
 *   The date and the range appear in both on purpose: the document must repeat what is registered on-chain.
 */
export function buildLotRegistration(form, { chainId, registry, chainNow, attachments = [] }) {
  const productCode = form.productCode.trim();
  const lotNumber = form.lotNumber.trim();
  const manufactureDate = resolveManufactureDate(dateInputToUnix(form.manufactureDate), chainNow);
  const minTempTenthsC = parseTemperature(form.minTemp);
  const maxTempTenthsC = parseTemperature(form.maxTemp);

  return {
    productHash: computeProductHash(productCode, lotNumber),
    manufactureDate,
    minTempTenthsC,
    maxTempTenthsC,
    metadataFields: {
      chainId,
      registry,
      productCode,
      lotNumber,
      productName: form.productName.trim(),
      manufacturerName: form.manufacturerName.trim(),
      site: form.site.trim(),
      manufactureDate,
      expiryDate: dateInputToUnix(form.expiryDate),
      storage: { minTenthsC: minTempTenthsC, maxTenthsC: maxTempTenthsC },
      attachments,
    },
  };
}

/**
 * Describe an uploaded attachment for the lot metadata.
 *
 * @param {object} file
 * @param {string} file.fileName     name of the file the person chose
 * @param {string} file.fileType     media type reported by the browser; may be empty
 * @param {boolean} file.encrypted   true when the uploaded bytes are an encryption envelope
 * @param {{ cid: string, contentHash: string, size: number }} file.stored answer of the upload service
 * @returns {{ name: string, kind: string, mediaType: string, cid: string, contentHash: string, size: number, encrypted: boolean }}
 *   the argument of buildAttachment from the shared builders
 */
export function describeAttachment({ fileName, fileType, encrypted, stored }) {
  return {
    name: fileName.trim().slice(0, MAX_FILE_NAME_LENGTH) || "attachment",
    // The form offers one generic attachment; a finer category would need a field nobody asked for.
    kind: "supporting-document",
    mediaType: MEDIA_TYPE_PATTERN.test(fileType) ? fileType : "application/octet-stream",
    cid: stored.cid,
    contentHash: stored.contentHash,
    size: stored.size,
    encrypted,
  };
}

/**
 * Tell whether a chosen file would exceed the upload service's size limit.
 *
 * @param {number} fileSize        size of the chosen file in bytes
 * @param {boolean} encrypted      whether it will be encrypted first (the envelope adds a few bytes)
 * @param {number} maxUploadBytes  the limit reported by the service's /health
 * @returns {boolean}
 */
export function exceedsUploadLimit(fileSize, encrypted, maxUploadBytes) {
  return fileSize + (encrypted ? ENVELOPE_OVERHEAD_BYTES : 0) > maxUploadBytes;
}

/**
 * Check the "Issue certificate" form.
 *
 * @param {typeof EMPTY_CERTIFICATE_FORM} form
 * @returns {Record<string, string>} field name -> message; empty when the form is valid
 */
export function validateCertificateForm(form) {
  const errors = {};
  requireText(errors, form, "certificateNumber", "certificate number", MAX_CODE_LENGTH);
  requireText(errors, form, "issuerName", "issuer name", MAX_TEXT_LENGTH);
  requireText(errors, form, "scope", "scope", MAX_TEXT_LENGTH);
  requireText(errors, form, "statement", "statement", MAX_STATEMENT_LENGTH);
  return errors;
}

/**
 * Convert a valid "Issue certificate" form into the fields of buildRegulatorCertificate.
 *
 * @param {typeof EMPTY_CERTIFICATE_FORM} form a form for which validateCertificateForm returned no errors
 * @param {object} context
 * @param {number} context.chainId
 * @param {string} context.registry
 * @param {{ id: number, productHash: string }} context.lot the lot being certified, as read from the chain
 * @param {number} context.issuedAt   Unix seconds
 * @returns {object}
 */
export function buildCertificateFields(form, { chainId, registry, lot, issuedAt }) {
  return {
    chainId,
    registry,
    lotId: lot.id,
    // Repeating the on-chain product hash ties the certificate to the product as well as to the lot id.
    productHash: lot.productHash.toLowerCase(),
    certificateNumber: form.certificateNumber.trim(),
    issuerName: form.issuerName.trim(),
    scope: form.scope.trim(),
    statement: form.statement.trim(),
    issuedAt,
  };
}

/**
 * Record an error unless the field holds some text within its length limit.
 *
 * @param {Record<string, string>} errors  collected messages; modified in place
 * @param {Record<string, string>} form
 * @param {string} field                   key in `form`
 * @param {string} label                   what the field is called in a sentence
 * @param {number} maxLength               the schema's limit for the field
 */
function requireText(errors, form, field, label, maxLength) {
  const value = String(form[field] ?? "").trim();
  if (value === "") errors[field] = `Enter the ${label}.`;
  else if (value.length > maxLength) errors[field] = `The ${label} can be at most ${maxLength} characters long.`;
}
