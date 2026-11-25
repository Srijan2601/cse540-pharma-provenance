/**
 * Node entry point of the document library: loads the JSON Schema files from
 * docs/schemas/ and wires them to the validator and the builders.
 *
 *   const documents = createDocuments();
 *   const { document, bytes, contentHash } = documents.buildSensorLog({ ... });
 *   const { cid } = await storage.add(bytes, { name: "sensor-log.json" });
 *   // anchorSensorLog(lotId, { cid, contentHash })
 *
 * The schema files are read once, when createDocuments() is called, and the
 * returned object carries the compiled validators; nothing is cached at
 * module level. The browser dApp skips this file and passes the schemas it
 * bundles to createDocumentValidator() directly.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OracleError } from "../errors.js";
import { createDocumentBuilders } from "./builders.js";
import { decodeDocument } from "./serialize.js";
import { createDocumentValidator } from "./validator.js";

export { SCHEMA_VERSION, buildAttachment, computeProductHash, createDocumentBuilders } from "./builders.js";
export { decodeDocument, serializeDocument } from "./serialize.js";
export { createDocumentValidator } from "./validator.js";

/** docs/schemas/ in this repository (this file is oracle/src/documents/index.js). */
export const DEFAULT_SCHEMAS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/schemas");

/**
 * Read every *.schema.json file of a directory.
 * @param {string} [dir] defaults to docs/schemas/
 * @returns {object[]} the parsed schemas, in file-name order
 * @throws {OracleError} when the directory or a file cannot be read or parsed
 */
export function loadSchemaFiles(dir = DEFAULT_SCHEMAS_DIR) {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".schema.json"))
      .sort()
      .map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")));
  } catch (error) {
    throw new OracleError(`Cannot load the document schemas from ${dir}: ${error.message}`, { code: "SCHEMAS_UNAVAILABLE", cause: error });
  }
}

/**
 * Create the document toolkit: validation, parsing and the three builders.
 *
 * @param {{ schemasDir?: string }} [options] where the *.schema.json files are; defaults to docs/schemas/
 * @returns {{
 *   types: readonly string[],
 *   validate: (document: unknown, expectedType?: string) => import("./validator.js").ValidationResult,
 *   assertValid: (document: unknown, expectedType?: string) => string,
 *   parse: (bytes: Uint8Array|ArrayBuffer, expectedType?: string) => { type: string, document: object },
 *   buildLotMetadata: (fields: object) => import("./builders.js").BuiltDocument,
 *   buildRegulatorCertificate: (fields: object) => import("./builders.js").BuiltDocument,
 *   buildSensorLog: (fields: object) => import("./builders.js").BuiltDocument
 * }}
 */
export function createDocuments({ schemasDir = DEFAULT_SCHEMAS_DIR } = {}) {
  const validator = createDocumentValidator(loadSchemaFiles(schemasDir));
  const builders = createDocumentBuilders(validator);

  /**
   * Decode and validate downloaded bytes. Use it to READ a document; to check
   * integrity, hash the original bytes (verifyContent), never a re-serialized copy.
   * @param {Uint8Array|ArrayBuffer} bytes
   * @param {string} [expectedType]
   * @returns {{ type: string, document: object }}
   * @throws {import("../errors.js").DocumentValidationError}
   */
  function parse(bytes, expectedType) {
    const document = decodeDocument(bytes);
    const type = validator.assertValid(document, expectedType);
    return { type, document: /** @type {object} */ (document) };
  }

  return Object.freeze({ ...validator, parse, ...builders });
}
