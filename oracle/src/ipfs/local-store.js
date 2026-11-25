/**
 * LocalStore: content-addressed files in one directory, one file per CID.
 *
 * It plays two roles:
 *   - with the "local" backend it IS the storage, which is what makes the
 *     demo run with no IPFS node, account or network;
 *   - with a remote backend (kubo, pinata) it is the write-through cache that
 *     keeps reads working when the remote service is unreachable.
 *
 * Safety properties:
 *   - A file name is never taken from caller input. The CID string is parsed
 *     first, and the name is the canonical base32 CIDv1 re-encoded from the
 *     parsed bytes, so it contains only [a-z2-7]: no separators, no "..", and
 *     no upper/lower-case pairs that would collide on a case-insensitive file
 *     system (the macOS default). A CIDv0 and its CIDv1 form share one file.
 *   - Tamper evidence. For raw + sha2-256 CIDs the bytes are re-hashed on
 *     every read and write; a file edited or corrupted on disk is reported as
 *     an IntegrityError and never returned.
 *   - Writes are atomic (temporary file, then rename), so the gateway service
 *     and the oracle can share the directory without a reader ever seeing a
 *     half-written file.
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { IntegrityError, NotFoundError, StorageError } from "../errors.js";
import { cidMatchesBytes, parseCid, toBytes } from "./cid.js";

/** A directory of content-addressed files: put(cid, bytes), get(cid), has(cid). */
export class LocalStore {
  /**
   * @param {{ dir: string }} options `dir` is created on first write if it does not exist
   */
  constructor({ dir }) {
    if (typeof dir !== "string" || dir === "") {
      throw new TypeError("LocalStore needs a directory path.");
    }
    /** Absolute path of the store directory. */
    this.dir = path.resolve(dir);
  }

  /**
   * The file that holds (or would hold) the content of a CID.
   * @param {string} cid
   * @returns {string} absolute path inside the store directory
   * @throws {import("../errors.js").InvalidCidError} when `cid` is not a well-formed CID
   */
  pathFor(cid) {
    return path.join(this.dir, parseCid(cid).v1);
  }

  /**
   * Store bytes under a CID. Storing the same CID again is harmless: the
   * content is identical by definition, and the file is simply rewritten.
   *
   * @param {string} cid the CID the content is known by (computed locally or returned by a pinning service)
   * @param {Uint8Array|ArrayBuffer} bytes
   * @returns {Promise<void>}
   * @throws {IntegrityError} when the CID is raw + sha2-256 and the bytes do not hash to it
   * @throws {StorageError} when the directory cannot be written
   */
  async put(cid, bytes) {
    const parsed = parseCid(cid);
    const content = toBytes(bytes);
    if (cidMatchesBytes(parsed, content) === false) {
      throw new IntegrityError(parsed.text, "the caller");
    }
    const target = path.join(this.dir, parsed.v1);
    // The temporary name starts with "." and is not a valid CID, so it can never be served or listed as content.
    const temporary = path.join(this.dir, `.tmp-${randomUUID()}`);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(temporary, content, { flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new StorageError("local", `Cannot write to the local store at ${this.dir}: ${error.message}`, { cause: error });
    }
  }

  /**
   * Read the content of a CID.
   * @param {string} cid
   * @returns {Promise<Uint8Array>}
   * @throws {NotFoundError} when the store has no file for this CID
   * @throws {IntegrityError} when the file no longer matches a raw + sha2-256 CID
   */
  async get(cid) {
    const parsed = parseCid(cid);
    let content;
    try {
      content = await readFile(path.join(this.dir, parsed.v1));
    } catch (error) {
      if (error.code === "ENOENT") throw new NotFoundError(parsed.text);
      throw new StorageError("local", `Cannot read from the local store at ${this.dir}: ${error.message}`, { cause: error });
    }
    if (cidMatchesBytes(parsed, content) === false) {
      throw new IntegrityError(parsed.text, "the local store");
    }
    // Copied into a plain Uint8Array: callers get the documented type, backed by memory nothing else shares.
    return new Uint8Array(content);
  }

  /**
   * Tell whether the store has a file for a CID (without reading or checking it).
   * @param {string} cid
   * @returns {Promise<boolean>}
   */
  async has(cid) {
    const file = this.pathFor(cid);
    try {
      await access(file);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw new StorageError("local", `Cannot read from the local store at ${this.dir}: ${error.message}`, { cause: error });
    }
  }
}
