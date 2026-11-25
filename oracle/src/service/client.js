/**
 * UploadServiceClient: talks to the upload + gateway service over HTTP.
 *
 * It offers the same three methods as a storage backend (add, get, has), so
 * code written against the storage interface can run either next to the
 * store (createStorage) or against a service on another machine, plus
 * health() for a start-up check.
 *
 * The client does not simply trust the service:
 *   - after an upload it recomputes keccak256 of the bytes it sent and
 *     refuses an answer whose contentHash or size differs, so a faulty
 *     service cannot make the caller anchor a hash of something else;
 *   - a download for a raw + sha2-256 CID is checked against the CID.
 *
 * No Node-only imports: this file also runs in the browser, so the dApp can
 * use it for its uploads.
 */

import { IntegrityError, NotFoundError, ServiceRequestError } from "../errors.js";
import { cidMatchesBytes, computeContentHash, parseCid, toBytes } from "../ipfs/cid.js";

const DEFAULT_TIMEOUT_MS = 30000;

/** HTTP client of the upload + gateway service: health(), add(), get(), has(), urlFor(). */
export class UploadServiceClient {
  /** Upload token; private so a logged client cannot print it. */
  #token;
  /** The fetch implementation. */
  #fetch;

  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]   service address, default http://127.0.0.1:8787
   * @param {string|null} [options.token] UPLOAD_TOKEN of the service, if it requires one
   * @param {typeof fetch} [options.fetch] fetch implementation (tests inject one)
   * @param {number} [options.timeoutMs]  abort a request after this long
   */
  constructor({ baseUrl = "http://127.0.0.1:8787", token = null, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    /** Service address without a trailing slash. */
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    /** Name reported as the "backend" of this storage object. */
    this.name = "service";
    this.timeoutMs = timeoutMs;
    this.#token = token;
    this.#fetch = fetch;
  }

  /**
   * The gateway URL of a CID on this service.
   * @param {string} cid
   * @returns {string}
   * @throws {import("../errors.js").InvalidCidError}
   */
  urlFor(cid) {
    return `${this.baseUrl}/ipfs/${parseCid(cid).text}`;
  }

  /**
   * GET /health.
   * @returns {Promise<{ ok: boolean, backend: string, maxUploadBytes: number }>}
   * @throws {ServiceRequestError} the service is unreachable or unhealthy
   */
  async health() {
    const response = await this.#request("GET", "/health");
    return this.#json(response);
  }

  /**
   * POST /upload.
   * @param {Uint8Array|ArrayBuffer} bytes the exact bytes to store
   * @param {{ name?: string }} [options] optional file name label
   * @returns {Promise<{ cid: string, contentHash: string, size: number }>}
   * @throws {ServiceRequestError} the service refused the upload (status 400, 401, 403, 413, 502, ...) or is unreachable
   * @throws {IntegrityError} the service answered with a hash, size or CID that does not match the bytes sent
   */
  async add(bytes, { name } = {}) {
    const content = toBytes(bytes);
    const query = name === undefined ? "" : `?name=${encodeURIComponent(name)}`;
    const headers = { "Content-Type": "application/octet-stream" };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    const stored = await this.#json(await this.#request("POST", `/upload${query}`, { headers, body: content }));

    let parsed;
    try {
      parsed = parseCid(stored?.cid);
    } catch {
      throw new ServiceRequestError(`The service at ${this.baseUrl} answered an upload without a valid CID; is this the upload service?`);
    }
    if (stored.contentHash !== computeContentHash(content) || stored.size !== content.length || cidMatchesBytes(parsed, content) === false) {
      throw new IntegrityError(parsed.text, `the upload service at ${this.baseUrl}`);
    }
    return { cid: parsed.text, contentHash: stored.contentHash, size: stored.size };
  }

  /**
   * GET /ipfs/<cid>.
   * @param {string} cid
   * @returns {Promise<Uint8Array>}
   * @throws {NotFoundError} the service has no content for the CID
   * @throws {IntegrityError} the bytes do not match a raw + sha2-256 CID
   * @throws {ServiceRequestError} any other failure
   */
  async get(cid) {
    const parsed = parseCid(cid);
    const response = await this.#request("GET", `/ipfs/${parsed.text}`);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      throw new NotFoundError(parsed.text, `the service at ${this.baseUrl}`);
    }
    if (!response.ok) await this.#fail(response);
    const content = new Uint8Array(await response.arrayBuffer());
    if (cidMatchesBytes(parsed, content) === false) {
      throw new IntegrityError(parsed.text, `the service at ${this.baseUrl}`);
    }
    return content;
  }

  /**
   * HEAD /ipfs/<cid>.
   * @param {string} cid
   * @returns {Promise<boolean>}
   * @throws {ServiceRequestError}
   */
  async has(cid) {
    const response = await this.#request("HEAD", `/ipfs/${parseCid(cid).text}`);
    if (response.status === 404) return false;
    if (!response.ok) await this.#fail(response);
    return true;
  }

  /**
   * Send one request; transport failures become ServiceRequestError.
   * @param {string} method
   * @param {string} path
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async #request(method, path, init = {}) {
    try {
      return await this.#fetch(`${this.baseUrl}${path}`, { ...init, method, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const reason = error?.name === "TimeoutError" ? `did not answer within ${this.timeoutMs} ms` : "cannot be reached";
      // No cause attached: the failed request may carry the upload token.
      throw new ServiceRequestError(`The upload service at ${this.baseUrl} ${reason}. Start it with "npm run service".`);
    }
  }

  /**
   * Read a JSON answer, turning an error status into ServiceRequestError.
   * @param {Response} response
   * @returns {Promise<any>}
   */
  async #json(response) {
    if (!response.ok) await this.#fail(response);
    try {
      return await response.json();
    } catch {
      throw new ServiceRequestError(`The service at ${this.baseUrl} did not answer with JSON; is this the upload service?`, {
        status: response.status,
      });
    }
  }

  /**
   * Throw for an error status, using the service's { error } message when there is one.
   * @param {Response} response
   * @returns {Promise<never>}
   */
  async #fail(response) {
    let detail = "";
    try {
      detail = (await response.json()).error ?? "";
    } catch {
      detail = "";
    }
    throw new ServiceRequestError(`The upload service answered HTTP ${response.status}${detail ? `: ${detail}` : "."}`, {
      status: response.status,
    });
  }
}
