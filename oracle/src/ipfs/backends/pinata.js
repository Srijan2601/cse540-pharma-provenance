/**
 * PinataBackend: pins files with the Pinata pinning service (Files API v3).
 *
 *   POST https://uploads.pinata.cloud/v3/files
 *   Authorization: Bearer <PINATA_JWT>
 *   body: multipart/form-data with
 *     network      "public"   (the public IPFS network; Pinata's default is its private network)
 *     cid_version  "v1"       (CIDv1, raw leaves, 256 KiB chunks: single-chunk files get the
 *                              same "bafkrei..." CID as the local backend)
 *     name         label shown in the Pinata dashboard
 *     file         the bytes
 *   answer: { "data": { "cid": "<cid>", "size": ..., ... } }
 *
 * Request shape taken from the Pinata API reference ("Upload a File",
 * docs.pinata.cloud) as published in November 2026.
 *
 * Handling of the credential (PINATA_JWT):
 *   - it is held in a private field, so logging the backend cannot print it;
 *   - it is sent to the upload endpoint and nowhere else; reads go through
 *     the local directory or the public gateway without any credential;
 *   - redirects are refused, so a redirect cannot carry the header to a
 *     different host;
 *   - plain http is refused unless the endpoint is a loopback address (the
 *     tests run a mock on 127.0.0.1);
 *   - it is never part of an error message, even if the service echoes it.
 */

import { StorageError } from "../../errors.js";
import { StorageBackend } from "../backend.js";

/** The production upload endpoint of the Pinata Files API. */
export const PINATA_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";

const DEFAULT_TIMEOUT_MS = 60000;

/** Storage backend that pins files with the Pinata pinning service (IPFS_BACKEND=pinata). */
export class PinataBackend extends StorageBackend {
  /** The JWT; private so it is invisible to console.log, util.inspect and JSON.stringify. */
  #jwt;
  /** The fetch implementation. */
  #fetch;

  /**
   * @param {object} options
   * @param {string} options.jwt                                              the Pinata JWT (already revealed from the config)
   * @param {import("../local-store.js").LocalStore} options.store            write-through cache directory
   * @param {import("../gateway.js").GatewayClient|null} [options.gateway]    read fallback
   * @param {string} [options.uploadUrl]                                      endpoint override, used by tests
   * @param {typeof fetch} [options.fetch]                                    fetch implementation (tests inject one)
   * @param {number} [options.timeoutMs]                                      abort an upload after this long
   */
  constructor({ jwt, store, gateway = null, uploadUrl = PINATA_UPLOAD_URL, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    super({ name: "pinata", store, gateway });
    if (typeof jwt !== "string" || jwt === "") {
      throw new TypeError("PinataBackend needs the Pinata JWT.");
    }
    const endpoint = new URL(uploadUrl);
    const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "[::1]" || /^127\./.test(endpoint.hostname);
    if (endpoint.protocol !== "https:" && !loopback) {
      throw new TypeError("PinataBackend refuses to send the JWT over plain http to a non-loopback host.");
    }
    this.uploadUrl = endpoint.href;
    this.timeoutMs = timeoutMs;
    this.#jwt = jwt;
    this.#fetch = fetch;
  }

  /**
   * Upload and pin the bytes on Pinata's public network.
   * @param {Uint8Array} bytes
   * @param {string} name sanitized file name
   * @returns {Promise<string>} the CID reported by Pinata
   * @throws {StorageError} the service is unreachable, too slow, rejected the credential, or answered with an error
   */
  async pin(bytes, name) {
    const form = new FormData();
    form.append("network", "public");
    form.append("cid_version", "v1");
    form.append("name", name);
    form.append("file", new Blob([bytes], { type: "application/octet-stream" }), name);

    let response;
    try {
      response = await this.#fetch(this.uploadUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#jwt}` },
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error?.name === "TimeoutError" ? `did not answer within ${this.timeoutMs} ms` : "cannot be reached";
      // The cause is not attached: a transport error may describe the request, and the request carries the JWT.
      throw new StorageError("pinata", `Pinata ${reason}. Check the network connection, or use IPFS_BACKEND=local for an offline demo.`, {
        transient: true,
      });
    }

    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new StorageError(
        "pinata",
        `Pinata rejected the credential (HTTP ${response.status}). Check that PINATA_JWT is current and that its API key has the org:files:write scope.`,
        { status: response.status },
      );
    }
    if (!response.ok) {
      throw new StorageError("pinata", `Pinata answered HTTP ${response.status}: ${this.#withoutJwt(text).trim().slice(0, 200)}`, {
        status: response.status,
      });
    }
    let cid;
    try {
      cid = JSON.parse(text).data?.cid;
    } catch {
      cid = undefined;
    }
    if (typeof cid !== "string") {
      throw new StorageError("pinata", 'Pinata answered without a "data.cid" field.');
    }
    return cid;
  }

  /**
   * Remove the JWT from text that is about to be put in an error message.
   * @param {string} text
   * @returns {string}
   */
  #withoutJwt(text) {
    return text.split(this.#jwt).join("[hidden]");
  }
}
