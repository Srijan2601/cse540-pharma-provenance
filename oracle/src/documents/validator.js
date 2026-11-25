/**
 * Document validation driven by the JSON Schema files in docs/schemas/.
 *
 * The schema files are the single source of truth: this module is handed the
 * parsed schemas and learns the document types from them (a schema describes
 * a document type when it pins properties.type to a constant). Nothing about
 * a document's fields is repeated in code.
 *
 * Validation has two stages:
 *   1. the JSON Schema (draft 2020-12), compiled with Ajv in strict mode, so
 *      a mistake in a schema file is an error at start-up and unknown
 *      properties in a document are rejected;
 *   2. a few cross-field rules that JSON Schema cannot express (an ordering,
 *      one field compared with another, an address checksum). They are listed
 *      in docs/schemas/README.md and implemented in CROSS_FIELD_RULES below.
 *      They only run on a document that passed stage 1, so they can rely on
 *      the shape being right.
 *
 * All problems are returned, each with a JSON Pointer to the offending value.
 *
 * No Node-only imports: the dApp can build the same validator from the schema
 * files it bundles.
 */

import Ajv2020 from "ajv/dist/2020.js";
import { isAddress } from "ethers";

import { DocumentValidationError } from "../errors.js";
import { isCid } from "../ipfs/cid.js";

/**
 * @typedef {{ path: string, message: string }} DocumentProblem
 * @typedef {{ valid: boolean, type: string|null, errors: DocumentProblem[] }} ValidationResult
 */

/** Path used for problems that concern the document as a whole. */
const ROOT = "(document)";

/**
 * Build a validator from parsed schema objects.
 *
 * @param {object[]} schemas every schema file, including the shared definitions; each needs an "$id"
 * @returns {{
 *   types: readonly string[],
 *   validate: (document: unknown, expectedType?: string) => ValidationResult,
 *   assertValid: (document: unknown, expectedType?: string) => string
 * }}
 *   `types` lists the document types found in the schemas.
 *   `validate` never throws for a bad document; `assertValid` throws DocumentValidationError and returns the type otherwise.
 * @throws {Error} when a schema file is itself invalid (Ajv strict mode)
 */
export function createDocumentValidator(schemas) {
  // allErrors: report every problem in one pass. allowUnionTypes: the schemas use ["object", "null"].
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  for (const schema of schemas) {
    ajv.addSchema(schema);
  }

  /** @type {Map<string, import("ajv").ValidateFunction>} */
  const byType = new Map();
  for (const schema of schemas) {
    const type = schema?.properties?.type?.const;
    if (typeof type === "string") {
      byType.set(type, ajv.getSchema(schema.$id));
    }
  }
  const types = Object.freeze([...byType.keys()].sort());

  /**
   * Validate a parsed document.
   * @param {unknown} document
   * @param {string} [expectedType] when given, a document of any other type is invalid
   * @returns {ValidationResult}
   */
  function validate(document, expectedType) {
    if (!isPlainObject(document)) {
      return failure(null, [{ path: ROOT, message: "must be a JSON object" }]);
    }
    const declared = typeof document.type === "string" ? document.type : null;
    if (expectedType !== undefined && !byType.has(expectedType)) {
      return failure(declared, [{ path: ROOT, message: `unknown document type "${expectedType}"; known types: ${types.join(", ")}` }]);
    }
    if (expectedType !== undefined && declared !== expectedType) {
      return failure(declared, [
        { path: "/type", message: `expected a "${expectedType}" document but "type" is ${JSON.stringify(document.type)}` },
      ]);
    }
    const check = declared === null ? undefined : byType.get(declared);
    if (check === undefined) {
      return failure(declared, [{ path: "/type", message: `must be one of: ${types.join(", ")}` }]);
    }

    if (!check(document)) {
      return failure(declared, check.errors.map(describeSchemaError));
    }
    const errors = CROSS_FIELD_RULES[declared]?.(document) ?? [];
    return errors.length === 0 ? { valid: true, type: declared, errors: [] } : failure(declared, errors);
  }

  /**
   * Validate and throw on failure.
   * @param {unknown} document
   * @param {string} [expectedType]
   * @returns {string} the document type
   * @throws {DocumentValidationError}
   */
  function assertValid(document, expectedType) {
    const result = validate(document, expectedType);
    if (!result.valid) {
      throw new DocumentValidationError(result.type ?? expectedType ?? "unknown", result.errors);
    }
    return /** @type {string} */ (result.type);
  }

  return Object.freeze({ types, validate, assertValid });
}

/**
 * Cross-field rules per document type. Each receives a document that already
 * matches its schema and returns the problems it finds.
 * @type {Record<string, (document: any) => DocumentProblem[]>}
 */
const CROSS_FIELD_RULES = {
  "lot-metadata": (document) => [
    ...checkRegistry(document),
    ...checkRange(document.storage, "/storage"),
    ...(document.expiryDate > document.manufactureDate
      ? []
      : [{ path: "/expiryDate", message: "must be later than manufactureDate" }]),
    ...checkAttachments(document.attachments),
  ],

  "regulator-certificate": (document) => [
    ...checkRegistry(document),
    ...(document.validUntil === undefined || document.validUntil > document.issuedAt
      ? []
      : [{ path: "/validUntil", message: "must be later than issuedAt" }]),
    ...checkAttachments(document.attachments ?? []),
  ],

  "sensor-log": (document) => {
    const errors = [...checkRegistry(document), ...checkRange(document.range, "/range")];
    const { readings, range, excursion } = document;

    for (let i = 1; i < readings.length; i++) {
      if (readings[i].t <= readings[i - 1].t) {
        errors.push({ path: `/readings/${i}/t`, message: "readings must be ordered by strictly increasing t" });
      }
    }
    if (document.startedAt > readings[0].t) {
      errors.push({ path: "/startedAt", message: "must not be later than the first reading" });
    }
    if (document.endedAt < readings.at(-1).t) {
      errors.push({ path: "/endedAt", message: "must not be earlier than the last reading" });
    }

    if (excursion !== null) {
      // The excursion is what the oracle puts on-chain, so it must be backed by the data in this very file.
      if (!readings.some((reading) => reading.t === excursion.t && reading.tenthsC === excursion.tenthsC)) {
        errors.push({ path: "/excursion", message: "must repeat one of the readings (same t and tenthsC)" });
      }
      if (excursion.tenthsC >= range.minTenthsC && excursion.tenthsC <= range.maxTenthsC) {
        errors.push({ path: "/excursion/tenthsC", message: "must lie outside range; the contract rejects an in-range excursion" });
      }
    }
    return errors;
  },
};

/**
 * Check the registry address beyond its shape.
 * @param {{ registry: string }} document
 * @returns {DocumentProblem[]}
 */
function checkRegistry(document) {
  // The schema pattern checks the shape; ethers also checks the EIP-55 checksum of a mixed-case address,
  // which catches a mistyped character.
  return isAddress(document.registry) ? [] : [{ path: "/registry", message: "has an invalid EIP-55 checksum" }];
}

/**
 * Check that a temperature range is not empty or inverted.
 * @param {{ minTenthsC: number, maxTenthsC: number }} range
 * @param {string} path JSON Pointer of the range, for the problem report
 * @returns {DocumentProblem[]}
 */
function checkRange(range, path) {
  // The contract enforces the same rule at registration (InvalidTemperatureRange).
  return range.minTenthsC < range.maxTenthsC ? [] : [{ path: `${path}/minTenthsC`, message: "must be lower than maxTenthsC" }];
}

/**
 * Check that every attachment CID is a real CID.
 * @param {{ cid: string }[]} attachments
 * @returns {DocumentProblem[]}
 */
function checkAttachments(attachments) {
  // The schema pattern only approximates a CID; the real parser checks the encoding and the multihash.
  return attachments.flatMap((attachment, index) =>
    isCid(attachment.cid) ? [] : [{ path: `/attachments/${index}/cid`, message: "is not a well-formed CID" }],
  );
}

/**
 * Turn an Ajv error into a message that names the property involved.
 * @param {import("ajv").ErrorObject} error
 * @returns {DocumentProblem}
 */
function describeSchemaError(error) {
  const path = error.instancePath === "" ? ROOT : error.instancePath;
  switch (error.keyword) {
    case "required":
      return { path, message: `is missing the required property "${error.params.missingProperty}"` };
    case "additionalProperties":
      return { path, message: `has the unknown property "${error.params.additionalProperty}"` };
    case "const":
      return { path, message: `must be ${JSON.stringify(error.params.allowedValue)}` };
    default:
      return { path, message: error.message ?? "is invalid" };
  }
}

/**
 * Build the result for an invalid document.
 * @param {string|null} type the type the document declares, if any
 * @param {DocumentProblem[]} errors
 * @returns {ValidationResult}
 */
function failure(type, errors) {
  return { valid: false, type, errors };
}

/**
 * Tell whether a value is a JSON object (not an array, not null).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
