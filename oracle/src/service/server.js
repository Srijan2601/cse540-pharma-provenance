/**
 * Upload + gateway service (design decision O3).
 *
 * Why it exists:
 *   - The browser dApp must store files on IPFS, but a pinning-service
 *     credential placed in a web page is public. The dApp posts the file
 *     here instead, and this process, which holds the credential, pins it.
 *   - In the local fallback demo there is no IPFS network at all. This
 *     service is then also the gateway the verify page fetches from.
 *
 * HTTP API (a contract with frontend/):
 *   GET  /health        200 { ok: true, backend, maxUploadBytes }
 *   POST /upload        body = raw file bytes, optional ?name=<filename>
 *                       201 { cid, contentHash, size }
 *   GET  /ipfs/<cid>    200 the bytes; 400 malformed CID; 404 unknown CID
 *   HEAD /ipfs/<cid>    same headers, no body
 *   Every error is JSON { error: string } with a matching status code:
 *   400, 401, 403, 404, 405, 413, 500, 502.
 *
 * Security decisions:
 *   - Binds to 127.0.0.1 unless configured otherwise.
 *   - Reading is public (the content is public by design): /health and
 *     /ipfs/* answer any origin. Writing is not: POST /upload is refused
 *     for a browser origin that is not on the allow-list. The check is made
 *     on the server, not left to the browser, because a "simple"
 *     cross-origin POST is sent without a preflight and CORS would only hide
 *     the response from the page, not stop the upload.
 *   - Optional bearer token for uploads, compared in constant time; only a
 *     hash of the token is kept in memory.
 *   - The upload size limit is enforced while the body streams in, so an
 *     oversized upload is refused after at most one chunk past the limit
 *     instead of being buffered first.
 *   - The <cid> path segment is parsed as a CID before anything else is done
 *     with it. Only the canonical re-encoding of a valid CID ever reaches the
 *     storage layer, so "../" sequences, encoded separators and absolute
 *     paths cannot influence which file is read.
 *   - Stored content is served as JSON or as an opaque download, with
 *     nosniff and a restrictive CSP, so an uploaded HTML or script file is
 *     never rendered or executed in this origin.
 *
 * Built on node:http only; no web framework.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import {
  ContentTooLargeError,
  IntegrityError,
  InvalidCidError,
  InvalidContentError,
  NotFoundError,
  OracleError,
  StorageError,
} from "../errors.js";
import { MAX_RAW_BLOCK_BYTES, parseCid } from "../ipfs/cid.js";

/** A CID never changes meaning, so its content may be cached forever. */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/** How long the server keeps discarding the rest of a request it has already refused. */
const DISCARD_GRACE_MS = 5000;
/** Upper bound for receiving one complete request; frees connections held open by stalled clients. */
const REQUEST_TIMEOUT_MS = 60000;
/** How long close() waits for in-flight requests before cutting connections. */
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

/** Marks a request whose client went away before the body was complete; there is nobody left to answer. */
class ClientClosedError extends Error {}

/**
 * @typedef {object} UploadService
 * @property {import("node:http").Server} server             the underlying HTTP server
 * @property {() => Promise<{ host: string, port: number, url: string }>} listen  start listening; resolves with the bound address
 * @property {(options?: { graceMs?: number }) => Promise<void>} close            stop accepting, finish in-flight requests, then resolve
 */

/**
 * Create the service. Nothing listens until listen() is called.
 *
 * The option names match config.service, so the usual call is
 * createUploadService({ storage, ...config.service, log }).
 *
 * @param {object} options
 * @param {{ name?: string, add: Function, get: Function }} options.storage  a storage backend (see src/ipfs); only add and get are used
 * @param {string} [options.host]                 address to bind, default 127.0.0.1
 * @param {number} [options.port]                 port to bind, default 8787; 0 lets the OS choose
 * @param {readonly string[]} [options.corsOrigins] browser origins allowed to POST /upload
 * @param {number} [options.maxUploadBytes]       largest accepted upload body, default 1 MiB
 * @param {{ reveal(): string }|string|null} [options.uploadToken] when set, POST /upload requires "Authorization: Bearer <token>"
 * @param {(line: string) => void} [options.log]  receives one line per request; never receives header values or tokens
 * @returns {UploadService}
 */
export function createUploadService({
  storage,
  host = "127.0.0.1",
  port = 8787,
  corsOrigins = [],
  maxUploadBytes = MAX_RAW_BLOCK_BYTES,
  uploadToken = null,
  log = () => {},
}) {
  const allowedOrigins = new Set(corsOrigins);
  const backendName = storage.name ?? "unknown";
  // Only a digest of the token is retained; presented tokens are hashed the same way before comparing.
  const tokenDigest = uploadToken ? digestToken(typeof uploadToken === "string" ? uploadToken : uploadToken.reveal()) : null;

  /** Responses not yet finished; close() needs them to end keep-alive on connections that are busy when it is called. */
  const inFlight = new Set();

  const server = createServer((request, response) => {
    inFlight.add(response);
    response.once("close", () => inFlight.delete(response));
    route(request, response).catch((error) => {
      // Reached only for defects: every expected failure is answered inside route().
      log(`${request.method} ${forLog(pathOf(request))} failed unexpectedly: ${error?.stack ?? error}`);
      if (!response.headersSent) {
        sendError(response, 500, "Internal error.");
      } else {
        response.destroy();
      }
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  // A request that is not valid HTTP gets a minimal 400; the default would close the socket without an answer.
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    } else {
      socket.destroy();
    }
  });

  /**
   * Dispatch one request by path and method.
   * @param {import("node:http").IncomingMessage} request
   * @param {import("node:http").ServerResponse} response
   */
  async function route(request, response) {
    const path = pathOf(request);
    response.once("finish", () => log(`${request.method} ${forLog(path)} ${response.statusCode}`));

    if (path === "/health") {
      return allowMethods(request, response, ["GET", "HEAD"], publicCors(), () =>
        sendJson(response, 200, { ok: true, backend: backendName, maxUploadBytes }, publicCors()),
      );
    }
    if (path === "/upload") {
      return handleUpload(request, response);
    }
    if (path.startsWith("/ipfs/")) {
      return allowMethods(request, response, ["GET", "HEAD"], publicCors(), () => handleFetch(request, response, path));
    }
    return sendError(response, 404, "Unknown path. This service offers GET /health, POST /upload and GET /ipfs/<cid>.", publicCors());
  }

  /**
   * POST /upload (and its CORS preflight).
   * @param {import("node:http").IncomingMessage} request
   * @param {import("node:http").ServerResponse} response
   */
  async function handleUpload(request, response) {
    const origin = request.headers.origin;
    const originAllowed = origin === undefined || allowedOrigins.has(origin);
    // "Vary: Origin" on every answer: the CORS headers depend on who asks, and caches must know that.
    const cors = origin !== undefined && originAllowed ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };

    if (request.method === "OPTIONS") {
      if (!originAllowed) {
        return sendError(response, 403, "This origin is not allowed to upload.", cors);
      }
      response.writeHead(204, {
        ...cors,
        Allow: "POST, OPTIONS",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      });
      return response.end();
    }
    if (request.method !== "POST") {
      return refuseUpload(request, response, 405, "Use POST to upload.", { ...cors, Allow: "POST, OPTIONS" });
    }
    if (!originAllowed) {
      return refuseUpload(request, response, 403, "This origin is not allowed to upload. Add it to IPFS_SERVICE_CORS_ORIGINS.", cors);
    }
    if (tokenDigest !== null && !bearerMatches(request.headers.authorization, tokenDigest)) {
      return refuseUpload(request, response, 401, "A valid upload token is required (Authorization: Bearer <token>).", {
        ...cors,
        "WWW-Authenticate": "Bearer",
      });
    }
    const tooLarge = `The upload is larger than the ${maxUploadBytes}-byte limit.`;
    // Cheap early exit when the client announces the size; the streaming check below does not rely on it.
    if (Number(request.headers["content-length"]) > maxUploadBytes) {
      return refuseUpload(request, response, 413, tooLarge, cors);
    }

    let body;
    try {
      body = await readBody(request, maxUploadBytes);
    } catch (error) {
      if (error instanceof ContentTooLargeError) return refuseUpload(request, response, 413, tooLarge, cors);
      if (error instanceof ClientClosedError) return undefined;
      throw error;
    }
    if (body.length === 0) {
      return sendError(response, 400, "The request body is empty. Send the file bytes as the body of the POST.", cors);
    }

    const name = queryOf(request).get("name") ?? undefined;
    try {
      const stored = await storage.add(body, { name });
      return sendJson(response, 201, { cid: stored.cid, contentHash: stored.contentHash, size: stored.size }, cors);
    } catch (error) {
      return sendStorageFailure(response, error, cors);
    }
  }

  /**
   * GET or HEAD /ipfs/<cid>.
   * @param {import("node:http").IncomingMessage} request
   * @param {import("node:http").ServerResponse} response
   * @param {string} path the raw request path, starting with "/ipfs/"
   */
  async function handleFetch(request, response, path) {
    let cid;
    try {
      // Everything after "/ipfs/" must be exactly one CID. decodeURIComponent throws on malformed
      // escapes, and parseCid rejects anything that is not a canonical CID, including decoded "/" and "..".
      cid = parseCid(decodeURIComponent(path.slice("/ipfs/".length))).text;
    } catch (error) {
      const reason = error instanceof InvalidCidError ? error.message : "The path is not valid percent-encoding.";
      return sendError(response, 400, `Malformed CID in the path. ${reason}`, publicCors());
    }

    let content;
    try {
      content = await storage.get(cid);
    } catch (error) {
      return sendStorageFailure(response, error, publicCors());
    }

    const etag = `"${cid}"`;
    const headers = {
      ...publicCors(),
      "Cache-Control": IMMUTABLE_CACHE,
      ETag: etag,
      "X-Ipfs-Path": `/ipfs/${cid}`,
      "X-Content-Type-Options": "nosniff",
      // Uploaded bytes are untrusted. If a browser is pointed straight at this URL, nothing in the
      // response may load or run.
      "Content-Security-Policy": "default-src 'none'; sandbox",
    };
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers);
      return response.end();
    }
    response.writeHead(200, {
      ...headers,
      "Content-Type": isJson(content) ? "application/json" : "application/octet-stream",
      "Content-Length": content.length,
    });
    // For a HEAD request node:http sends the headers above and drops the body by itself.
    return response.end(content);
  }

  /**
   * Start listening.
   * @returns {Promise<{ host: string, port: number, url: string }>}
   */
  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        const reason =
          error.code === "EADDRINUSE"
            ? `Port ${port} on ${host} is already in use. Is the service already running? Set IPFS_SERVICE_PORT to use another port.`
            : `Cannot listen on ${host}:${port}: ${error.message}`;
        reject(new OracleError(reason, { code: "SERVICE_LISTEN_FAILED", cause: error }));
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.removeListener("error", onError);
        const address = /** @type {import("node:net").AddressInfo} */ (server.address());
        const printableHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
        resolve({ host: address.address, port: address.port, url: `http://${printableHost}:${address.port}` });
      });
    });
  }

  /**
   * Shut down gracefully: stop accepting connections, let in-flight requests
   * finish, and cut whatever is still open after the grace period.
   * @param {{ graceMs?: number }} [options]
   * @returns {Promise<void>}
   */
  function close({ graceMs = DEFAULT_SHUTDOWN_GRACE_MS } = {}) {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      const timer = setTimeout(() => server.closeAllConnections(), graceMs);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      // Keep-alive connections would otherwise hold the server open until they time out: idle ones
      // are closed now, busy ones are told to close as soon as their current answer has been sent.
      server.closeIdleConnections();
      for (const response of inFlight) {
        if (!response.headersSent) response.setHeader("Connection", "close");
      }
    });
  }

  return Object.freeze({ server, listen, close });
}

/**
 * CORS headers for the public, read-only routes: any origin may read.
 * @returns {Record<string, string>}
 */
function publicCors() {
  return { "Access-Control-Allow-Origin": "*" };
}

/**
 * Run `handler` when the method is allowed; answer preflights and 405 otherwise.
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {string[]} methods allowed methods besides OPTIONS
 * @param {Record<string, string>} cors
 * @param {() => unknown} handler
 */
function allowMethods(request, response, methods, cors, handler) {
  const allow = [...methods, "OPTIONS"].join(", ");
  if (request.method === "OPTIONS") {
    response.writeHead(204, { ...cors, Allow: allow, "Access-Control-Allow-Methods": allow, "Access-Control-Max-Age": "600" });
    return response.end();
  }
  if (!methods.includes(request.method)) {
    return sendError(response, 405, `Method ${request.method} is not allowed here. Allowed: ${allow}.`, { ...cors, Allow: allow });
  }
  return handler();
}

/**
 * The raw path of a request, without the query string. It is deliberately
 * NOT normalized: "/ipfs/../x" stays as it is and fails CID validation,
 * instead of being rewritten into some other route.
 * @param {import("node:http").IncomingMessage} request
 * @returns {string}
 */
function pathOf(request) {
  return (request.url ?? "").split("?")[0];
}

/**
 * Make a client-supplied path safe to write to a log: bounded length, so a
 * request cannot flood the log, and printable ASCII only. node:http already
 * refuses control and non-ASCII bytes in a request line; the replacement
 * keeps the log safe without depending on that.
 * @param {string} path
 * @returns {string}
 */
function forLog(path) {
  const clean = path.replace(/[^\x21-\x7e]/g, "?");
  return clean.length > 200 ? `${clean.slice(0, 200)}...` : clean;
}

/**
 * The query parameters of a request.
 * @param {import("node:http").IncomingMessage} request
 * @returns {URLSearchParams}
 */
function queryOf(request) {
  const url = request.url ?? "";
  const start = url.indexOf("?");
  return new URLSearchParams(start === -1 ? "" : url.slice(start + 1));
}

/**
 * Collect a request body, failing as soon as it exceeds the limit.
 * @param {import("node:http").IncomingMessage} request
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onClose);
      request.removeListener("close", onClose);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > limit) {
        // Stop buffering at once: nothing beyond the limit is kept in memory.
        cleanup();
        reject(new ContentTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onClose = () => {
      cleanup();
      reject(new ClientClosedError("the client closed the connection before the upload was complete"));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onClose);
    request.once("close", onClose);
  });
}

/**
 * Answer an upload request that is being refused while (part of) its body is
 * still on the way.
 *
 * The answer is sent immediately. The rest of the body is then read and
 * thrown away for a short grace period, because closing a socket that still
 * has unread data makes many clients report a connection reset instead of
 * showing the status code. A client that keeps sending past the grace period
 * is disconnected.
 *
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {string} message
 * @param {Record<string, string>} headers
 */
function refuseUpload(request, response, status, message, headers) {
  sendError(response, status, message, headers);
  if (!request.complete) {
    const { socket } = request;
    const timer = setTimeout(() => socket.destroy(), DISCARD_GRACE_MS);
    // The timer ends with the body or with the connection, whichever comes first. The socket is
    // watched directly because node:http stops reporting on a request once its response is sent.
    // Both listeners are removed together so a long-lived connection does not collect them.
    const settle = () => {
      clearTimeout(timer);
      request.removeListener("end", settle);
      socket.removeListener("close", settle);
    };
    request.once("end", settle);
    socket.once("close", settle);
    request.resume();
  }
}

/**
 * Map a storage-layer error to an HTTP answer. Internal details (paths,
 * upstream messages) stay in the server log; the client gets a short reason.
 * @param {import("node:http").ServerResponse} response
 * @param {unknown} error
 * @param {Record<string, string>} headers
 */
function sendStorageFailure(response, error, headers) {
  if (error instanceof NotFoundError) return sendError(response, 404, "No content is stored for this CID.", headers);
  if (error instanceof InvalidCidError) return sendError(response, 400, error.message, headers);
  if (error instanceof InvalidContentError) return sendError(response, 400, error.message, headers);
  if (error instanceof ContentTooLargeError) return sendError(response, 413, error.message, headers);
  if (error instanceof IntegrityError) {
    return sendError(response, 500, "The stored content failed its integrity check and was not served.", headers);
  }
  if (error instanceof StorageError) {
    return sendError(response, 502, `The ${error.backend} storage backend is not available.`, headers);
  }
  throw error;
}

/**
 * Send a JSON body. Used for /health, upload results and errors, none of which may be cached.
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {object} body
 * @param {Record<string, string>} [headers]
 */
function sendJson(response, status, body, headers = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    ...headers,
    "Content-Type": "application/json",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(payload);
}

/**
 * Send an error as JSON { error }.
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {string} message
 * @param {Record<string, string>} [headers]
 */
function sendError(response, status, message, headers = {}) {
  sendJson(response, status, { error: message }, headers);
}

/**
 * Decide the Content-Type of stored bytes: JSON if they parse as JSON text, opaque bytes otherwise.
 * @param {Uint8Array} content
 * @returns {boolean}
 */
function isJson(content) {
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
    return true;
  } catch {
    return false;
  }
}

/**
 * Hash an upload token, so that only the digest has to be kept and compared.
 * @param {string} token
 * @returns {Buffer} sha2-256 of the token
 */
function digestToken(token) {
  return createHash("sha256").update(token).digest();
}

/**
 * Check an Authorization header against the expected token digest in constant time.
 * Hashing both sides first gives timingSafeEqual the equal-length inputs it requires
 * and hides the length of the real token.
 * @param {string|undefined} header
 * @param {Buffer} expectedDigest
 * @returns {boolean}
 */
function bearerMatches(header, expectedDigest) {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? "");
  return match !== null && timingSafeEqual(digestToken(match[1]), expectedDigest);
}
