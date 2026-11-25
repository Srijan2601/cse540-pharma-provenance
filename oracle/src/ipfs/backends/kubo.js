/**
 * KuboBackend: pins files on a Kubo node (IPFS Desktop or `ipfs daemon`)
 * through its RPC API.
 *
 *   POST <KUBO_API_URL>/api/v0/add?cid-version=1&raw-leaves=true&pin=true
 *   body: multipart/form-data with one part named "file"
 *   answer: one JSON object per added entry, {"Name": "...", "Hash": "<cid>", "Size": "..."}
 *
 * cid-version=1 with raw-leaves=true makes a file that fits in one chunk
 * (256 KiB by default) a single raw block, so its CID is identical to the one
 * the local backend computes. Larger files are chunked into a DAG and get a
 * dag-pb ("bafybei...") CID, which this package accepts but cannot re-check
 * against the file bytes.
 *
 * The Kubo RPC API is an administrative interface without authentication of
 * its own; it should stay bound to 127.0.0.1, which is Kubo's default.
 */

import { StorageError } from "../../errors.js";
import { StorageBackend } from "../backend.js";

const DEFAULT_TIMEOUT_MS = 30000;

/** Storage backend that pins files on a Kubo node through its RPC API (IPFS_BACKEND=kubo). */
export class KuboBackend extends StorageBackend {
  /** The fetch implementation; private so a logged backend shows only its settings. */
  #fetch;

  /**
   * @param {object} options
   * @param {string} options.apiUrl                                           base URL of the RPC API, for example "http://127.0.0.1:5001"
   * @param {import("../local-store.js").LocalStore} options.store            write-through cache directory
   * @param {import("../gateway.js").GatewayClient|null} [options.gateway]    read fallback
   * @param {typeof fetch} [options.fetch]                                    fetch implementation (tests inject one)
   * @param {number} [options.timeoutMs]                                      abort an upload after this long
   */
  constructor({ apiUrl, store, gateway = null, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    super({ name: "kubo", store, gateway });
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.#fetch = fetch;
  }

  /**
   * Add and pin the bytes on the Kubo node.
   * @param {Uint8Array} bytes
   * @param {string} name sanitized file name, sent as the multipart filename
   * @returns {Promise<string>} the CID computed by the node
   * @throws {StorageError} the node is unreachable, too slow, or answered with an error
   */
  async pin(bytes, name) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/octet-stream" }), name);

    let response;
    try {
      response = await this.#fetch(`${this.apiUrl}/api/v0/add?cid-version=1&raw-leaves=true&pin=true`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error?.name === "TimeoutError" ? `did not answer within ${this.timeoutMs} ms` : "cannot be reached";
      throw new StorageError(
        "kubo",
        `The Kubo RPC API at ${this.apiUrl} ${reason}. Start IPFS Desktop or "ipfs daemon", check KUBO_API_URL, or use IPFS_BACKEND=local.`,
        // Transient: the node may simply be starting or busy, so the oracle retries before it gives up.
        { cause: error, transient: true },
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new StorageError("kubo", `The Kubo RPC API answered HTTP ${response.status}: ${text.trim().slice(0, 200)}`, {
        status: response.status,
      });
    }
    // The answer is newline-delimited JSON with one object per added entry. One file without a
    // wrapping directory yields one object; reading the last line also tolerates progress lines.
    const lastLine = text.trim().split("\n").at(-1) ?? "";
    let hash;
    try {
      hash = JSON.parse(lastLine).Hash;
    } catch {
      hash = undefined;
    }
    if (typeof hash !== "string") {
      throw new StorageError("kubo", 'The Kubo RPC API answered without a "Hash" field; is KUBO_API_URL really a Kubo RPC endpoint?');
    }
    return hash;
  }
}
