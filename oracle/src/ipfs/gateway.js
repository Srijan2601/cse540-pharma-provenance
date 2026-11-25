/**
 * GatewayClient: read-only access to an IPFS HTTP gateway (path style,
 * <base>/<cid>). It is the fallback for content that is not in the local
 * store, for example a certificate another organization pinned.
 *
 * A gateway is an untrusted third party, so:
 *   - no credentials are ever sent to it (requests carry no Authorization
 *     header and no cookies);
 *   - a response for a raw + sha2-256 CID is re-hashed and rejected with
 *     IntegrityError if it does not match the CID. Other CID types cannot be
 *     checked here; their callers compare the keccak256 content hash;
 *   - the response is read with a size cap and a timeout, so a slow or
 *     misbehaving gateway cannot hang the oracle or exhaust its memory.
 *
 * No Node-only imports: this file also runs in the browser.
 */

import { IntegrityError, NotFoundError, StorageError } from "../errors.js";
import { cidMatchesBytes, parseCid } from "./cid.js";

/** Default cap on a gateway response, equal to the largest upload the service can be configured to accept. */
const DEFAULT_MAX_BYTES = 33554432;
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Validate a gateway URL and normalize it to a prefix that a CID can be
 * appended to. "https://host" and "https://host/" become
 * "https://host/ipfs/"; any other path only gains a trailing slash, so
 * "http://127.0.0.1:8787/ipfs" and a custom path prefix both work.
 *
 * @param {string} value
 * @returns {string} the normalized prefix, ending in "/"
 * @throws {TypeError} when the value is not an http(s) URL, or has a query string, fragment or credentials
 */
export function normalizeGatewayUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.search || url.hash || url.username || url.password) {
    throw new TypeError(
      'A gateway must be an http(s) URL prefix such as "https://ipfs.io/ipfs/", without query string, fragment or credentials.',
    );
  }
  const basePath = url.pathname === "/" ? "/ipfs/" : url.pathname.replace(/\/*$/, "/");
  return `${url.origin}${basePath}`;
}

/** Read-only client for one IPFS HTTP gateway: get(cid), has(cid), urlFor(cid). */
export class GatewayClient {
  /** The fetch implementation; private so a logged client shows only its settings. */
  #fetch;

  /**
   * @param {object} options
   * @param {string} options.baseUrl URL prefix a CID is appended to, for example "https://ipfs.io/ipfs/"
   * @param {typeof fetch} [options.fetch] fetch implementation (tests inject one)
   * @param {number} [options.timeoutMs] abort a request after this long
   * @param {number} [options.maxBytes] reject responses larger than this
   */
  constructor({ baseUrl, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES }) {
    /** URL prefix, always ending in "/". */
    this.baseUrl = normalizeGatewayUrl(baseUrl);
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.#fetch = fetch;
  }

  /**
   * The gateway URL of a CID.
   * @param {string} cid
   * @returns {string}
   * @throws {import("../errors.js").InvalidCidError} when `cid` is malformed (it is validated before it is put in a URL)
   */
  urlFor(cid) {
    return `${this.baseUrl}${parseCid(cid).text}`;
  }

  /**
   * Download the content of a CID.
   * @param {string} cid
   * @returns {Promise<Uint8Array>}
   * @throws {NotFoundError} the gateway does not have the content (HTTP 404 or 410)
   * @throws {IntegrityError} the bytes do not match a raw + sha2-256 CID
   * @throws {StorageError} the gateway is unreachable, too slow, or answered with another error
   */
  async get(cid) {
    const parsed = parseCid(cid);
    const response = await this.#request(parsed.text, "GET");
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {});
      throw new NotFoundError(parsed.text, `the local store or the gateway ${this.baseUrl}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new StorageError("gateway", `The gateway ${this.baseUrl} answered HTTP ${response.status} for ${parsed.text}.`, {
        status: response.status,
      });
    }
    const bytes = await this.#readLimited(response, parsed.text);
    if (cidMatchesBytes(parsed, bytes) === false) {
      throw new IntegrityError(parsed.text, `the gateway ${this.baseUrl}`);
    }
    return bytes;
  }

  /**
   * Ask the gateway whether it has the content of a CID (HTTP HEAD).
   * @param {string} cid
   * @returns {Promise<boolean>}
   * @throws {StorageError} the gateway is unreachable or answered with an unexpected status
   */
  async has(cid) {
    const parsed = parseCid(cid);
    const response = await this.#request(parsed.text, "HEAD");
    if (response.ok) return true;
    if (response.status === 404 || response.status === 410) return false;
    throw new StorageError("gateway", `The gateway ${this.baseUrl} answered HTTP ${response.status} for ${parsed.text}.`, {
      status: response.status,
    });
  }

  /**
   * Send one request and translate transport failures.
   * @param {string} cid a validated CID string
   * @param {"GET"|"HEAD"} method
   * @returns {Promise<Response>}
   */
  async #request(cid, method) {
    try {
      return await this.#fetch(`${this.baseUrl}${cid}`, {
        method,
        // Public gateways redirect to their subdomain form; following is safe because the request carries no credentials.
        redirect: "follow",
        credentials: "omit",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error?.name === "TimeoutError" ? `did not answer within ${this.timeoutMs} ms` : "could not be reached";
      throw new StorageError("gateway", `The gateway ${this.baseUrl} ${reason} (${method} ${cid}).`, { cause: error });
    }
  }

  /**
   * Read a response body, giving up as soon as it exceeds the size cap.
   * @param {Response} response
   * @param {string} cid for messages
   * @returns {Promise<Uint8Array>}
   */
  async #readLimited(response, cid) {
    const tooLarge = () =>
      new StorageError("gateway", `The gateway response for ${cid} is larger than the ${this.maxBytes}-byte limit.`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    const chunks = [];
    let total = 0;
    try {
      // Content-Length may be absent or wrong, so the cap is enforced on the bytes actually received.
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > this.maxBytes) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("gateway", `The download of ${cid} from ${this.baseUrl} was interrupted.`, { cause: error });
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
}
