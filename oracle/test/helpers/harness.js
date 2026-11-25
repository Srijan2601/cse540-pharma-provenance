/**
 * Shared test helpers: temporary directories, throw-away HTTP servers that
 * record what they receive, and a raw HTTP client.
 *
 * Every helper registers its own clean-up with the test context, so a test
 * that fails half-way still closes its servers and removes its files.
 * Servers listen on 127.0.0.1 with port 0 (the OS picks a free port), so the
 * suite can run in parallel with anything else on the machine.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Create an empty temporary directory that is deleted when the test ends.
 * @param {import("node:test").TestContext} t
 * @returns {Promise<string>} absolute path
 */
export async function temporaryDirectory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "oracle-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * @typedef {object} RecordedRequest
 * @property {string} method
 * @property {string} url        raw request target, including the query string
 * @property {import("node:http").IncomingHttpHeaders} headers
 * @property {Buffer} body
 */

/**
 * Start a mock HTTP server. Each request is recorded (with its full body) and
 * then passed to `respond`, which decides the answer.
 *
 * @param {import("node:test").TestContext} t
 * @param {(request: RecordedRequest, response: import("node:http").ServerResponse) => void | Promise<void>} respond
 * @returns {Promise<{ url: string, port: number, requests: RecordedRequest[], close: () => Promise<void> }>}
 */
export async function startMockServer(t, respond) {
  /** @type {RecordedRequest[]} */
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const recorded = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) };
      requests.push(recorded);
      try {
        await respond(recorded, response);
      } catch (error) {
        // A failing assertion inside a mock must not hang the client; the test sees a 500 and fails on it.
        response.writeHead(500, { "Content-Type": "text/plain" }).end(String(error?.stack ?? error));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(close);
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, port, requests, close };
}

/**
 * Parse a recorded multipart/form-data body with the platform's own parser.
 * @param {RecordedRequest} request
 * @returns {Promise<FormData>}
 */
export function multipartOf(request) {
  return new Response(request.body, { headers: { "Content-Type": request.headers["content-type"] } }).formData();
}

/**
 * Send one HTTP request with node:http and collect the answer.
 *
 * Unlike fetch, node:http sends the path exactly as given (no "../"
 * normalization, no re-encoding), which the path-traversal tests need.
 *
 * @param {string} baseUrl for example "http://127.0.0.1:8787"
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {string} [options.path]     raw request target
 * @param {Record<string, string>} [options.headers]
 * @param {Uint8Array|string} [options.body]
 * @returns {Promise<{ status: number, headers: import("node:http").IncomingHttpHeaders, body: Buffer, json: () => any }>}
 */
export function rawRequest(baseUrl, { method = "GET", path: target = "/", headers = {}, body } = {}) {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname, port, method, path: target, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const payload = Buffer.concat(chunks);
        resolve({ status: response.statusCode, headers: response.headers, body: payload, json: () => JSON.parse(payload.toString("utf8")) });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}
