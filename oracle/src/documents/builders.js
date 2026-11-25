/**
 * Builders for the three off-chain documents (design decision O2).
 *
 * A builder takes the fields of a document and returns
 *
 *   { document, bytes, contentHash }
 *
 *   document     the validated JSON object
 *   bytes        its one and only serialization (see serialize.js); upload these
 *   contentHash  keccak256(bytes); goes on-chain in the DocumentRef
 *
 * What a builder adds to its input:
 *   - schemaVersion and type;
 *   - a fixed key order, so the same fields always give the same bytes and
 *     therefore the same CID and content hash (re-running a seed script does
 *     not create a second, different copy of a document);
 *   - the registry address in EIP-55 checksum form;
 *   - defaults that follow from other fields (see each builder).
 * Then it validates the result against the schema and the cross-field rules
 * and throws DocumentValidationError listing every problem. A builder never
 * returns bytes for an invalid document, so an invalid document cannot be
 * hashed and anchored by accident. A misspelled field name is kept in the
 * document on purpose, so the schema reports it instead of it being dropped
 * silently.
 *
 * No Node-only imports: the dApp can use the same builders in the browser.
 */

import { AbiCoder, getAddress, isAddress, keccak256 } from "ethers";

import { ENCRYPTION_DESCRIPTOR } from "../crypto/envelope.js";
import { computeContentHash } from "../ipfs/cid.js";
import { serializeDocument } from "./serialize.js";

/** Version written into every document built here. */
export const SCHEMA_VERSION = 1;

/** Canonical key order of each object in the documents. */
const KEY_ORDER = Object.freeze({
  "lot-metadata": [
    "schemaVersion",
    "type",
    "chainId",
    "registry",
    "productCode",
    "lotNumber",
    "productName",
    "manufacturerName",
    "site",
    "manufactureDate",
    "expiryDate",
    "storage",
    "attachments",
  ],
  "regulator-certificate": [
    "schemaVersion",
    "type",
    "chainId",
    "registry",
    "lotId",
    "productHash",
    "certificateNumber",
    "issuerName",
    "scope",
    "statement",
    "issuedAt",
    "validUntil",
    "attachments",
  ],
  "sensor-log": [
    "schemaVersion",
    "type",
    "chainId",
    "registry",
    "lotId",
    "sensorId",
    "scenario",
    "range",
    "startedAt",
    "endedAt",
    "readings",
    "excursion",
  ],
  range: ["minTenthsC", "maxTenthsC"],
  attachment: ["name", "kind", "cid", "contentHash", "mediaType", "size", "encryption"],
  encryption: ["scheme", "envelope"],
  reading: ["t", "tenthsC"],
  excursion: ["t", "tenthsC", "rule"],
});

/**
 * @typedef {object} BuiltDocument
 * @property {object} document       the validated document
 * @property {Uint8Array} bytes      the bytes to upload, never to be re-serialized
 * @property {string} contentHash    keccak256(bytes), "0x" + 64 hex
 */

/**
 * The on-chain product hash of a lot: keccak256(abi.encode(string productCode, string lotNumber)).
 * The manufacturer passes it to registerBatch; a regulator certificate repeats it.
 *
 * @param {string} productCode exactly as written in the lot metadata
 * @param {string} lotNumber   exactly as written in the lot metadata
 * @returns {string} "0x" + 64 hex
 */
export function computeProductHash(productCode, lotNumber) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["string", "string"], [productCode, lotNumber]));
}

/**
 * Build the attachment entry for a file that was just uploaded.
 *
 * @param {object} file
 * @param {string} file.name          file name shown to people
 * @param {string} file.kind          kebab-case category, for example "certificate-of-analysis"
 * @param {string} file.mediaType     media type of the original (decrypted) file
 * @param {string} file.cid           from the storage backend's add()
 * @param {string} file.contentHash   from add(): keccak256 of the uploaded bytes
 * @param {number} file.size          from add(): number of uploaded bytes
 * @param {boolean} [file.encrypted]  true when the uploaded bytes are an AES-256-GCM envelope
 * @returns {object} an entry for a document's "attachments" array
 */
export function buildAttachment({ name, kind, mediaType, cid, contentHash, size, encrypted = false }) {
  return { name, kind, cid, contentHash, mediaType, size, encryption: encrypted ? { ...ENCRYPTION_DESCRIPTOR } : null };
}

/**
 * Create the three builders, bound to a validator.
 *
 * @param {{ assertValid: (document: unknown, expectedType?: string) => string }} validator from createDocumentValidator()
 * @returns {{
 *   buildLotMetadata: (fields: object) => BuiltDocument,
 *   buildRegulatorCertificate: (fields: object) => BuiltDocument,
 *   buildSensorLog: (fields: object) => BuiltDocument
 * }}
 */
export function createDocumentBuilders(validator) {
  /**
   * Shared tail of every builder: order the keys, validate, serialize once, hash.
   * @param {string} type
   * @param {object} fields
   * @returns {BuiltDocument}
   */
  function finish(type, fields) {
    const document = ordered({ ...fields, schemaVersion: SCHEMA_VERSION, type, registry: checksummed(fields.registry) }, KEY_ORDER[type]);
    validator.assertValid(document, type);
    const bytes = serializeDocument(document);
    return { document, bytes, contentHash: computeContentHash(bytes) };
  }

  return Object.freeze({
    /**
     * Lot metadata, uploaded by the manufacturer before registerBatch.
     *
     * @param {object} fields chainId, registry, productCode, lotNumber, productName, manufacturerName,
     *        site, manufactureDate, expiryDate, storage { minTenthsC, maxTenthsC } and optionally
     *        attachments (default: none)
     * @returns {BuiltDocument}
     * @throws {import("../errors.js").DocumentValidationError}
     */
    buildLotMetadata(fields) {
      return finish("lot-metadata", {
        ...fields,
        storage: orderedObject(fields.storage, KEY_ORDER.range),
        attachments: orderedAttachments(fields.attachments ?? []),
      });
    },

    /**
     * Regulator certificate, uploaded by the regulator before issueCertificate.
     *
     * @param {object} fields chainId, registry, lotId, productHash, certificateNumber, issuerName, scope,
     *        statement, issuedAt and optionally validUntil and attachments
     * @returns {BuiltDocument}
     * @throws {import("../errors.js").DocumentValidationError}
     */
    buildRegulatorCertificate(fields) {
      const { validUntil, attachments, ...rest } = fields;
      return finish("regulator-certificate", {
        ...rest,
        // Optional fields are left out entirely when absent; "undefined" has no JSON form.
        ...(validUntil === undefined ? {} : { validUntil }),
        ...(attachments === undefined ? {} : { attachments: orderedAttachments(attachments) }),
      });
    },

    /**
     * Sensor log, uploaded by the oracle before anchorSensorLog or reportExcursion.
     *
     * @param {object} fields chainId, registry, lotId, sensorId, scenario, range { minTenthsC, maxTenthsC },
     *        readings [{ t, tenthsC }] in time order, and optionally startedAt (default: time of the
     *        first reading), endedAt (default: time of the last reading) and excursion
     *        { t, tenthsC, rule } (default: null, meaning the rule did not trigger)
     * @returns {BuiltDocument}
     * @throws {import("../errors.js").DocumentValidationError}
     */
    buildSensorLog(fields) {
      const readings = Array.isArray(fields.readings) ? fields.readings : [];
      return finish("sensor-log", {
        ...fields,
        range: orderedObject(fields.range, KEY_ORDER.range),
        startedAt: fields.startedAt ?? readings[0]?.t,
        endedAt: fields.endedAt ?? readings.at(-1)?.t,
        readings: Array.isArray(fields.readings)
          ? fields.readings.map((reading) => orderedObject(reading, KEY_ORDER.reading))
          : fields.readings,
        excursion: fields.excursion == null ? null : orderedObject(fields.excursion, KEY_ORDER.excursion),
      });
    },
  });
}

/**
 * Copy an object with the listed keys first, in that order, followed by any
 * other keys in their original order (so the validator can report them).
 * Keys whose value is undefined are dropped, as JSON.stringify would do.
 *
 * @param {Record<string, unknown>} source
 * @param {readonly string[]} keys
 * @returns {Record<string, unknown>}
 */
function ordered(source, keys) {
  const result = {};
  for (const key of [...keys, ...Object.keys(source).filter((key) => !keys.includes(key))]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

/**
 * ordered() for a value that may not be an object at all; anything else is
 * passed through unchanged for the validator to reject.
 * @param {unknown} value
 * @param {readonly string[]} keys
 * @returns {unknown}
 */
function orderedObject(value, keys) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? ordered(value, keys) : value;
}

/**
 * Put every attachment entry, and its encryption descriptor, in canonical key order.
 * @param {unknown} attachments
 * @returns {unknown}
 */
function orderedAttachments(attachments) {
  if (!Array.isArray(attachments)) return attachments;
  return attachments.map((attachment) => {
    const entry = orderedObject(attachment, KEY_ORDER.attachment);
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.encryption != null) {
      entry.encryption = orderedObject(entry.encryption, KEY_ORDER.encryption);
    }
    return entry;
  });
}

/**
 * Write an address in EIP-55 checksum form so the same registry always
 * serializes to the same characters. An invalid value is passed through for
 * the validator to report.
 * @param {unknown} address
 * @returns {unknown}
 */
function checksummed(address) {
  return typeof address === "string" && isAddress(address) ? getAddress(address) : address;
}
