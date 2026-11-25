/**
 * StorageBackend: the one interface every storage backend offers (design decision O3).
 *
 *   add(bytes, { name }) -> { cid, contentHash, size }
 *   get(cid)             -> Uint8Array
 *   has(cid)             -> boolean
 *
 * The base class holds everything the three backends share, so the rules are
 * written once:
 *   - add() hashes the exact bytes it was given (keccak256, design decision O1),
 *     asks the subclass to pin them, checks the CID that came back, and then
 *     ALWAYS writes the bytes to the local directory. For the "local" backend
 *     that directory is the storage; for remote backends it is a write-through
 *     cache, so everything this machine uploaded stays readable when the
 *     pinning service or the network is down.
 *   - get() and has() read the local directory first and only then the
 *     configured gateway, if there is one.
 *
 * A subclass implements a single method, pin(bytes, name), which returns the
 * CID string computed by wherever the bytes were stored.
 */

import { IntegrityError, InvalidCidError, InvalidContentError, NotFoundError, StorageError } from "../errors.js";
import { cidMatchesBytes, computeContentHash, parseCid, toBytes } from "./cid.js";

/**
 * @typedef {object} StoredDocument
 * @property {string} cid          where the file is on IPFS
 * @property {string} contentHash  keccak256 of the uploaded bytes, "0x" + 64 hex
 * @property {number} size         number of bytes
 */

/**
 * Turn an optional, caller-supplied file name into a harmless label.
 *
 * The name is only metadata for a pinning service (it is never used as a
 * local path), but it is still reduced to [A-Za-z0-9._-] so it cannot carry
 * path separators, control characters or header-breaking bytes anywhere.
 *
 * @param {unknown} name
 * @returns {string} 1 to 128 safe characters; "file" when nothing usable was given
 */
export function sanitizeFileName(name) {
  if (typeof name !== "string") return "file";
  const safe = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 128);
  return safe === "" ? "file" : safe;
}

/** Base class of the storage backends: add(bytes, { name }), get(cid), has(cid). Subclasses implement pin(). */
export class StorageBackend {
  /**
   * @param {object} options
   * @param {string} options.name                                  backend name reported by /health ("local", "kubo", "pinata")
   * @param {import("./local-store.js").LocalStore} options.store  the local directory
   * @param {import("./gateway.js").GatewayClient|null} [options.gateway] read fallback, or null for none
   */
  constructor({ name, store, gateway = null }) {
    this.name = name;
    this.store = store;
    this.gateway = gateway;
  }

  /**
   * Store the bytes wherever this backend keeps them and return their CID.
   * Implemented by each subclass; `bytes` is non-empty and `name` is already sanitized.
   * @param {Uint8Array} bytes
   * @param {string} name
   * @returns {Promise<string>} the CID string
   */
  async pin(bytes, name) {
    throw new Error(`${this.constructor.name} does not implement pin().`);
  }

  /**
   * Upload a file.
   *
   * @param {Uint8Array|ArrayBuffer} bytes the exact bytes to store; they are hashed and uploaded unchanged
   * @param {{ name?: string }} [options] `name` is an optional label for pinning services
   * @returns {Promise<StoredDocument>} the values to put in an on-chain DocumentRef
   * @throws {InvalidContentError} empty content, or not a byte array
   * @throws {import("../errors.js").ContentTooLargeError} larger than the backend accepts
   * @throws {StorageError} the backend failed or returned an unusable answer
   * @throws {IntegrityError} a remote backend returned a CID that does not match the bytes
   */
  async add(bytes, { name } = {}) {
    const content = toBytes(bytes);
    if (content.length === 0) {
      // A zero-byte document is never legitimate here; it is the signature of a failed read or a mis-wired upload form.
      throw new InvalidContentError("Refusing to store an empty file.");
    }

    const reported = await this.pin(content, sanitizeFileName(name));

    let parsed;
    try {
      parsed = parseCid(reported);
    } catch (error) {
      if (!(error instanceof InvalidCidError)) throw error;
      throw new StorageError(this.name, `The ${this.name} backend returned a value that is not a CID: ${error.message}`);
    }
    // A raw CID is a plain hash of the file, so a remote service that stored different bytes is caught here.
    if (cidMatchesBytes(parsed, content) === false) {
      throw new IntegrityError(parsed.text, `the ${this.name} backend`);
    }

    await this.store.put(parsed.text, content);
    return { cid: parsed.text, contentHash: computeContentHash(content), size: content.length };
  }

  /**
   * Fetch a file by CID: local directory first, then the gateway.
   *
   * @param {string} cid
   * @returns {Promise<Uint8Array>}
   * @throws {import("../errors.js").InvalidCidError} malformed CID
   * @throws {NotFoundError} neither the local directory nor the gateway has it
   * @throws {IntegrityError} the only available copy does not match its CID
   * @throws {StorageError} the gateway failed
   */
  async get(cid) {
    const parsed = parseCid(cid);
    let localFailure;
    try {
      return await this.store.get(parsed.text);
    } catch (error) {
      // A missing file and a corrupted file both fall through to the gateway, which may still have a good copy.
      if (!(error instanceof NotFoundError) && !(error instanceof IntegrityError)) throw error;
      localFailure = error;
    }
    if (this.gateway === null) {
      throw localFailure;
    }
    const content = await this.gateway.get(parsed.text);
    if (parsed.isRawSha256) {
      // Only content the gateway client could verify against its CID is cached (which also repairs
      // a corrupted local copy). Unverifiable content is fetched again each time rather than
      // trusting one gateway response forever.
      await this.store.put(parsed.text, content);
    }
    return content;
  }

  /**
   * Tell whether a file is available: in the local directory, or else on the gateway.
   * @param {string} cid
   * @returns {Promise<boolean>}
   * @throws {import("../errors.js").InvalidCidError} malformed CID
   * @throws {StorageError} the gateway failed
   */
  async has(cid) {
    const parsed = parseCid(cid);
    if (await this.store.has(parsed.text)) return true;
    return this.gateway === null ? false : this.gateway.has(parsed.text);
  }
}
