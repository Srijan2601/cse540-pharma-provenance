/**
 * LocalBackend: the default, zero-configuration storage backend.
 *
 * Files are kept only in the local directory; nothing leaves the machine.
 * Each file is addressed as ONE raw IPFS block (CIDv1, raw codec, sha2-256),
 * the same CID `ipfs add --cid-version=1` gives any file of at most 256 KiB.
 * A demo recorded with this backend therefore shows the CIDs the same small
 * files would have on public IPFS, and the files can be pinned there later
 * without their on-chain references changing.
 *
 * Files above 1 MiB are rejected (MAX_RAW_BLOCK_BYTES in ../cid.js explains
 * why a larger single block would be useless on the public network).
 */

import { ContentTooLargeError } from "../../errors.js";
import { StorageBackend } from "../backend.js";
import { computeRawCid, MAX_RAW_BLOCK_BYTES } from "../cid.js";

/** Storage backend that keeps files in the local directory only (IPFS_BACKEND=local). */
export class LocalBackend extends StorageBackend {
  /**
   * @param {object} options
   * @param {import("../local-store.js").LocalStore} options.store            the directory that holds the files
   * @param {import("../gateway.js").GatewayClient|null} [options.gateway]    optional read fallback for CIDs pinned elsewhere
   * @param {number} [options.maxBytes]                                       largest accepted file, at most 1 MiB
   */
  constructor({ store, gateway = null, maxBytes = MAX_RAW_BLOCK_BYTES }) {
    super({ name: "local", store, gateway });
    this.maxBytes = Math.min(maxBytes, MAX_RAW_BLOCK_BYTES);
  }

  /**
   * Compute the single-block CID; the base class then writes the file to the directory.
   * @param {Uint8Array} bytes
   * @returns {Promise<string>}
   * @throws {ContentTooLargeError} above the one-block limit
   */
  async pin(bytes) {
    if (bytes.length > this.maxBytes) {
      throw new ContentTooLargeError(this.maxBytes, "the local backend stores each file as one IPFS block");
    }
    return computeRawCid(bytes);
  }
}
