/**
 * The one serialization of a JSON document (design decision O1).
 *
 * The on-chain contentHash is keccak256 of the exact uploaded bytes, and the
 * verify page hashes exactly the bytes a gateway returns. JSON has many
 * equivalent spellings (key order, spacing, line endings), so a document is
 * turned into bytes exactly ONCE, here, and those bytes are hashed, uploaded
 * and anchored as they are. Nothing downstream may parse and re-serialize a
 * document and expect the same hash.
 *
 *   bytes = UTF-8( JSON.stringify(document, null, 2) + "\n" )
 *
 * Two-space indentation keeps the files readable in a browser; the trailing
 * newline makes them well-formed text files. Key order is the insertion order
 * of the object, which the builders fix.
 *
 * No Node-only imports: this file also runs in the browser.
 */

import { DocumentValidationError } from "../errors.js";
import { toBytes } from "../ipfs/cid.js";

/**
 * Serialize a document to the bytes that are hashed and uploaded.
 * @param {object} document a JSON-compatible object
 * @returns {Uint8Array}
 */
export function serializeDocument(document) {
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
}

/**
 * Decode downloaded bytes into a JSON value, for reading only. The result
 * must not be re-serialized to recompute a hash; hash the original bytes.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {unknown} the parsed JSON value
 * @throws {DocumentValidationError} when the bytes are not valid UTF-8 or not valid JSON
 */
export function decodeDocument(bytes) {
  let text;
  try {
    // fatal: malformed UTF-8 is an error instead of being silently replaced with U+FFFD.
    text = new TextDecoder("utf-8", { fatal: true }).decode(toBytes(bytes));
  } catch {
    throw new DocumentValidationError("unknown", [{ path: "(document)", message: "the file is not valid UTF-8 text" }]);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DocumentValidationError("unknown", [{ path: "(document)", message: `the file is not valid JSON: ${error.message}` }]);
  }
}
