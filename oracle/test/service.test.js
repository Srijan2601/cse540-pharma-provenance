/**
 * End-to-end tests for the upload + gateway service and its
 * client helper. Each test starts a real service on 127.0.0.1 with an
 * OS-assigned port and talks to it over HTTP, so routing, headers, streaming
 * limits and CORS are tested exactly as a browser or curl would see them.
 *
 * Requests that need an exact request line (path-traversal attempts, a body
 * that is never finished) are sent with node:http, because fetch normalizes
 * paths and cannot leave a request open.
 */

import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { describe, test } from "node:test";

import { DEFAULT_CORS_ORIGINS, loadConfig } from "../src/config.js";
import { IntegrityError, NotFoundError, OracleError, ServiceRequestError } from "../src/errors.js";
import { KuboBackend, LocalBackend, LocalStore, computeContentHash, computeRawCid, createStorage } from "../src/ipfs/index.js";
import { UploadServiceClient } from "../src/service/client.js";
import { createUploadService } from "../src/service/server.js";
import { rawRequest, startMockServer, temporaryDirectory } from "./helpers/harness.js";

const utf8 = (text) => new TextEncoder().encode(text);
/** A made-up upload token; it only ever protects the throw-away services started below. */
const TOKEN = "test-upload-token-0123456789abcdef";
const ALLOWED_ORIGIN = "http://localhost:5173";

/**
 * Start a service backed by a fresh local store.
 * @returns {Promise<{ url: string, dir: string, storage: LocalBackend, service: object, logs: string[] }>}
 */
async function startService(t, options = {}) {
  const dir = options.dir ?? (await temporaryDirectory(t));
  const storage = options.storage ?? new LocalBackend({ store: new LocalStore({ dir }) });
  const logs = [];
  const service = createUploadService({
    storage,
    port: 0,
    corsOrigins: DEFAULT_CORS_ORIGINS,
    log: (line) => logs.push(line),
    ...options.service,
  });
  const { url } = await service.listen();
  t.after(() => service.close({ graceMs: 200 }));
  return { url, dir, storage, service, logs };
}

/** POST /upload with fetch. */
function upload(url, body, { headers = {}, name } = {}) {
  return fetch(`${url}/upload${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`, { method: "POST", body, headers });
}

describe("GET /health", () => {
  test("reports the backend and the upload limit", async (t) => {
    const { url } = await startService(t, { service: { maxUploadBytes: 4096 } });
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: true, backend: "local", maxUploadBytes: 4096 });
  });

  test("defaults: 1 MiB limit, and the bound address is the loopback interface", async (t) => {
    const { url } = await startService(t);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await (await fetch(`${url}/health`)).json()).maxUploadBytes, 1048576);
    const head = await fetch(`${url}/health`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });
});

describe("POST /upload then GET /ipfs/<cid>", () => {
  test("a JSON document: 201 { cid, contentHash, size }, then the same bytes back as application/json", async (t) => {
    const { url, dir } = await startService(t);
    const bytes = utf8(`${JSON.stringify({ schemaVersion: 1, type: "sensor-log", readings: [{ t: 1, tenthsC: 54 }] }, null, 2)}\n`);

    const posted = await upload(url, bytes, { headers: { "Content-Type": "application/json" }, name: "sensor-log.json" });
    assert.equal(posted.status, 201);
    assert.equal(posted.headers.get("content-type"), "application/json");
    const stored = await posted.json();
    assert.deepEqual(stored, { cid: computeRawCid(bytes), contentHash: computeContentHash(bytes), size: bytes.length });
    assert.deepEqual(await readdir(dir), [stored.cid]);

    const fetched = await fetch(`${url}/ipfs/${stored.cid}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("content-type"), "application/json");
    assert.equal(fetched.headers.get("content-length"), String(bytes.length));
    assert.equal(fetched.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");
    assert.equal(fetched.headers.get("etag"), `"${stored.cid}"`);
    assert.equal(fetched.headers.get("access-control-allow-origin"), "*");
    assert.equal(fetched.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    const body = new Uint8Array(await fetched.arrayBuffer());
    assert.deepEqual(body, bytes, "byte-for-byte what was uploaded");
    assert.equal(computeContentHash(body), stored.contentHash, "which is what the verify page checks");
  });

  test("binary content is served as application/octet-stream, whatever Content-Type it was uploaded with", async (t) => {
    const { url } = await startService(t);
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
    const { cid } = await (await upload(url, bytes, { headers: { "Content-Type": "text/html" } })).json();
    const fetched = await fetch(`${url}/ipfs/${cid}`);
    assert.equal(fetched.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(new Uint8Array(await fetched.arrayBuffer()), bytes);
  });

  test("uploaded HTML is never served as HTML", async (t) => {
    const { url } = await startService(t);
    const { cid } = await (await upload(url, utf8("<script>alert(1)</script>"), { headers: { "Content-Type": "text/html" } })).json();
    const fetched = await fetch(`${url}/ipfs/${cid}`);
    assert.equal(fetched.headers.get("content-type"), "application/octet-stream");
    assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");
  });

  test("uploading the same bytes twice gives the same answer", async (t) => {
    const { url, dir } = await startService(t);
    const first = await (await upload(url, utf8("same bytes"))).json();
    const second = await (await upload(url, utf8("same bytes"))).json();
    assert.deepEqual(first, second);
    assert.equal((await readdir(dir)).length, 1);
  });

  test("the name parameter is passed to the backend as a sanitized label", async (t) => {
    const seen = [];
    const storage = {
      name: "recording",
      add: async (bytes, options) => {
        seen.push(options.name);
        return { cid: computeRawCid(bytes), contentHash: computeContentHash(bytes), size: bytes.length };
      },
    };
    const { url } = await startService(t, { storage });
    await upload(url, utf8("a"), { name: "lot 7/metadata?.json" });
    await upload(url, utf8("b"));
    assert.deepEqual(seen, ["lot 7/metadata?.json", undefined], "the service forwards the name; the backend sanitizes it");
    assert.equal((await (await fetch(`${url}/health`)).json()).backend, "recording");
  });

  test("HEAD returns the headers of GET and no body", async (t) => {
    const { url } = await startService(t);
    const bytes = utf8('{"a":1}\n');
    const { cid } = await (await upload(url, bytes)).json();

    const head = await rawRequest(url, { method: "HEAD", path: `/ipfs/${cid}` });
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-type"], "application/json");
    assert.equal(head.headers["content-length"], String(bytes.length));
    assert.equal(head.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(head.headers.etag, `"${cid}"`);
    assert.equal(head.body.length, 0);

    const missing = await rawRequest(url, { method: "HEAD", path: `/ipfs/${computeRawCid(utf8("absent"))}` });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.length, 0);
  });

  test("a conditional GET with the matching ETag is answered 304", async (t) => {
    const { url } = await startService(t);
    const { cid } = await (await upload(url, utf8("cached forever"))).json();
    const notModified = await fetch(`${url}/ipfs/${cid}`, { headers: { "If-None-Match": `"${cid}"` } });
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), "");
    assert.equal((await fetch(`${url}/ipfs/${cid}`, { headers: { "If-None-Match": '"something-else"' } })).status, 200);
  });

  test("a CIDv0 path is accepted and looked up like any other CID", async (t) => {
    const { url } = await startService(t);
    const response = await fetch(`${url}/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG`);
    assert.equal(response.status, 404, "well formed, simply not stored here");
  });
});

describe("errors are JSON { error } with the right status", () => {
  test("400 for a malformed CID", async (t) => {
    const { url } = await startService(t);
    for (const segment of ["not-a-cid", "bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei", "BAFKREIFJJCIE6LYPI6NY7AMXNFFTAGCLBUXNDQONFIPMB64F2KM2DEVEI4", "", "123"]) {
      const response = await rawRequest(url, { path: `/ipfs/${segment}` });
      assert.equal(response.status, 400, segment);
      assert.equal(response.headers["content-type"], "application/json");
      assert.equal(response.headers["access-control-allow-origin"], "*", "a page can read the error");
      assert.match(response.json().error, /^Malformed CID in the path\./);
    }
  });

  test("404 for a well-formed CID that is not stored, and for unknown paths", async (t) => {
    const { url } = await startService(t);
    const unknownCid = await fetch(`${url}/ipfs/${computeRawCid(utf8("never uploaded"))}`);
    assert.equal(unknownCid.status, 404);
    assert.deepEqual(await unknownCid.json(), { error: "No content is stored for this CID." });

    for (const target of ["/", "/ipfs", "/uploads", "/health/", "/api/v0/add", "/favicon.ico", "/upload/extra"]) {
      const response = await rawRequest(url, { path: target });
      assert.equal(response.status, 404, target);
      assert.match(response.json().error, /^Unknown path/);
    }
  });

  test("405 with an Allow header for the wrong method", async (t) => {
    const { url } = await startService(t);
    const cid = computeRawCid(utf8("x"));
    const cases = [
      ["GET", "/upload", "POST, OPTIONS"],
      ["PUT", "/upload", "POST, OPTIONS"],
      ["DELETE", "/upload", "POST, OPTIONS"],
      ["POST", "/health", "GET, HEAD, OPTIONS"],
      ["POST", `/ipfs/${cid}`, "GET, HEAD, OPTIONS"],
      ["PUT", `/ipfs/${cid}`, "GET, HEAD, OPTIONS"],
      ["DELETE", `/ipfs/${cid}`, "GET, HEAD, OPTIONS"],
    ];
    for (const [method, target, allow] of cases) {
      const response = await rawRequest(url, { method, path: target });
      assert.equal(response.status, 405, `${method} ${target}`);
      assert.equal(response.headers.allow, allow);
      assert.equal(typeof response.json().error, "string");
    }
  });

  test("400 for an empty upload", async (t) => {
    const { url, dir } = await startService(t);
    const response = await upload(url, new Uint8Array(0));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /empty/);
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });

  test("502 when a remote backend is unreachable, 201 while it is reachable", async (t) => {
    const bytes = utf8("through kubo");
    const kubo = await startMockServer(t, (_request, response) => response.writeHead(200).end(JSON.stringify({ Name: "f", Hash: computeRawCid(bytes), Size: "12" })));
    const storage = new KuboBackend({ apiUrl: kubo.url, store: new LocalStore({ dir: await temporaryDirectory(t) }) });
    const { url, logs } = await startService(t, { storage });

    assert.equal((await (await fetch(`${url}/health`)).json()).backend, "kubo");
    const stored = await upload(url, bytes);
    assert.equal(stored.status, 201);
    const { cid } = await stored.json();

    await kubo.close();
    const failed = await upload(url, utf8("the node is gone"));
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: "The kubo storage backend is not available." });
    assert.equal((await fetch(`${url}/ipfs/${cid}`)).status, 200, "earlier uploads are still served from the local directory");
    assert.ok(logs.some((line) => /POST \/upload 502/.test(line)));
  });

  test("500 for a stored file that fails its integrity check: tampered bytes are never served", async (t) => {
    const { url, storage } = await startService(t);
    const { cid } = await (await upload(url, utf8('{"tenthsC": 54}\n'))).json();
    await writeFile(storage.store.pathFor(cid), '{"tenthsC": 94}\n');

    const response = await fetch(`${url}/ipfs/${cid}`);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.match(text, /integrity check/);
    assert.ok(!text.includes("94"));
  });

  test("500 without internal details when the backend fails unexpectedly", async (t) => {
    const storage = {
      name: "broken",
      add: async () => {
        throw new Error("secret internal path /var/lib/private");
      },
      get: async () => {
        throw new TypeError("boom at /var/lib/private");
      },
    };
    const { url, logs } = await startService(t, { storage });
    for (const response of [await upload(url, utf8("x")), await fetch(`${url}/ipfs/${computeRawCid(utf8("x"))}`)]) {
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Internal error." });
    }
    assert.ok(logs.some((line) => line.includes("/var/lib/private")), "the detail goes to the server log instead");
  });

  test("a request that is not HTTP gets 400, not a hung socket", async (t) => {
    const { url } = await startService(t);
    const { connect } = await import("node:net");
    const answer = await new Promise((resolve, reject) => {
      const socket = connect(Number(new URL(url).port), "127.0.0.1", () => socket.write("NOT HTTP AT ALL\r\n\r\n"));
      let received = "";
      socket.on("data", (chunk) => (received += chunk));
      socket.on("end", () => resolve(received));
      socket.on("error", reject);
    });
    assert.match(answer, /^HTTP\/1\.1 400 Bad Request/);
  });
});

describe("upload size limit (413)", () => {
  test("accepts a body of exactly the limit and rejects one byte more", async (t) => {
    const { url, dir } = await startService(t, { service: { maxUploadBytes: 1024 } });
    assert.equal((await upload(url, new Uint8Array(1024).fill(1))).status, 201);

    const tooLarge = await upload(url, new Uint8Array(1025).fill(1));
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { error: "The upload is larger than the 1024-byte limit." });
    assert.equal((await readdir(dir)).length, 1, "only the accepted upload was stored");
  });

  test("rejects an announced oversized body from its Content-Length alone", async (t) => {
    const { url } = await startService(t, { service: { maxUploadBytes: 1024 } });
    // The request line and headers are sent, but not a single body byte.
    const answer = await new Promise((resolve, reject) => {
      const request = httpRequest(`${url}/upload`, { method: "POST", headers: { "Content-Length": "5000000" } }, (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode);
          request.destroy();
        });
      });
      request.on("error", reject);
      request.flushHeaders();
    });
    assert.equal(answer, 413);
  });

  test("is enforced while the body is streaming, before the upload has finished", async (t) => {
    const { url, dir } = await startService(t, { service: { maxUploadBytes: 1024 } });
    // A chunked upload with no Content-Length that is never completed. A service that buffered the
    // whole body before checking its size could not answer at all; this one must answer 413 as soon
    // as the bytes received exceed the limit.
    const outcome = await new Promise((resolve, reject) => {
      const request = httpRequest(`${url}/upload`, { method: "POST" }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), requestFinished: request.writableEnded });
          request.destroy();
        });
      });
      request.on("error", reject);
      request.write(Buffer.alloc(600, 1));
      request.write(Buffer.alloc(600, 2)); // 1200 bytes sent: past the limit, and end() is never called
    });
    assert.equal(outcome.status, 413);
    assert.equal(outcome.requestFinished, false, "the answer arrived while the upload was still open");
    assert.match(outcome.body.error, /larger than the 1024-byte limit/);
    assert.deepEqual(await readdir(dir).catch(() => []), [], "nothing was stored");
  });

  test("a client that sends far more than the limit still receives a clean 413, not a connection reset", async (t) => {
    const { url, dir } = await startService(t, { service: { maxUploadBytes: 1024 } });

    // With a Content-Length (fetch sets it for a byte array): refused from the header.
    const announced = await upload(url, new Uint8Array(8 * 1048576));
    assert.equal(announced.status, 413);
    assert.match((await announced.json()).error, /1024-byte limit/);

    // Without one (a streamed, chunked body): refused after the first chunks; the rest is discarded.
    let sent = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (sent >= 8 * 1048576) return controller.close();
        sent += 65536;
        return controller.enqueue(new Uint8Array(65536));
      },
    });
    const streamed = await fetch(`${url}/upload`, { method: "POST", body: stream, duplex: "half" });
    assert.equal(streamed.status, 413);
    assert.match((await streamed.json()).error, /1024-byte limit/);
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });

  test("the local backend's own 1 MiB limit also maps to 413", async (t) => {
    // A service configured (by direct construction) with a limit above what the local backend can store.
    const { url } = await startService(t, { service: { maxUploadBytes: 4 * 1048576 } });
    const response = await upload(url, new Uint8Array(1048577));
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /1048576-byte limit/);
  });
});

describe("CORS", () => {
  test("reading is open to any origin", async (t) => {
    const { url } = await startService(t);
    const { cid } = await (await upload(url, utf8("public"))).json();
    for (const origin of ["https://verify.example", "http://localhost:5173", "null"]) {
      for (const target of ["/health", `/ipfs/${cid}`, "/ipfs/not-a-cid", "/nowhere"]) {
        const response = await rawRequest(url, { path: target, headers: { Origin: origin } });
        assert.equal(response.headers["access-control-allow-origin"], "*", `${origin} ${target}`);
      }
    }
    const preflight = await rawRequest(url, { method: "OPTIONS", path: `/ipfs/${cid}`, headers: { Origin: "https://verify.example", "Access-Control-Request-Method": "GET" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "*");
    assert.equal(preflight.headers["access-control-allow-methods"], "GET, HEAD, OPTIONS");
  });

  test("an allowed origin may upload and is echoed back, never a wildcard", async (t) => {
    const { url } = await startService(t);
    for (const origin of DEFAULT_CORS_ORIGINS) {
      const response = await upload(url, utf8(`from ${origin}`), { headers: { Origin: origin } });
      assert.equal(response.status, 201, origin);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.equal(response.headers.get("vary"), "Origin");
    }
  });

  test("a disallowed origin is refused by the server itself and nothing is stored", async (t) => {
    const { url, dir } = await startService(t);
    for (const origin of ["https://evil.example", "http://localhost:3000", "http://localhost:5173.evil.example", "null", "HTTP://LOCALHOST:5173"]) {
      // text/plain makes this a "simple" request: a browser would send it without a preflight.
      const response = await upload(url, utf8("drive-by upload"), { headers: { Origin: origin, "Content-Type": "text/plain" } });
      assert.equal(response.status, 403, origin);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(response.headers.get("vary"), "Origin");
      assert.match((await response.json()).error, /origin is not allowed/);
    }
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });

  test("a request without an Origin header (curl, Node, the oracle) may upload", async (t) => {
    const { url } = await startService(t);
    const response = await upload(url, utf8("from a script"));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });

  test("preflight for an allowed origin lists the method and headers the dApp needs", async (t) => {
    const { url } = await startService(t);
    const response = await rawRequest(url, {
      method: "OPTIONS",
      path: "/upload",
      headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
    });
    assert.equal(response.status, 204);
    assert.equal(response.body.length, 0);
    assert.equal(response.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
    assert.equal(response.headers["access-control-allow-methods"], "POST, OPTIONS");
    assert.equal(response.headers["access-control-allow-headers"], "Authorization, Content-Type");
    assert.equal(response.headers["access-control-max-age"], "600");
    assert.equal(response.headers.vary, "Origin");
  });

  test("preflight for a disallowed origin is refused without CORS headers", async (t) => {
    const { url } = await startService(t);
    const response = await rawRequest(url, { method: "OPTIONS", path: "/upload", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
    assert.equal(response.status, 403);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal(response.headers["access-control-allow-methods"], undefined);
  });

  test("the allow-list is configurable; an empty list blocks every browser origin", async (t) => {
    const custom = await startService(t, { service: { corsOrigins: ["https://dapp.example"] } });
    assert.equal((await upload(custom.url, utf8("a"), { headers: { Origin: "https://dapp.example" } })).status, 201);
    assert.equal((await upload(custom.url, utf8("a"), { headers: { Origin: ALLOWED_ORIGIN } })).status, 403);

    const none = await startService(t, { service: { corsOrigins: [] } });
    assert.equal((await upload(none.url, utf8("a"), { headers: { Origin: ALLOWED_ORIGIN } })).status, 403);
    assert.equal((await upload(none.url, utf8("a"))).status, 201);
  });
});

describe("upload token", () => {
  test("uploads need 'Authorization: Bearer <token>' when a token is configured", async (t) => {
    const { url, dir, logs } = await startService(t, { service: { uploadToken: TOKEN } });

    const missing = await upload(url, utf8("x"));
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), "Bearer");
    assert.match((await missing.json()).error, /upload token is required/);

    const wrong = [`Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, "Bearer ", `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN} extra`, `Bearer ${TOKEN.toUpperCase()}`];
    for (const authorization of wrong) {
      assert.equal((await upload(url, utf8("x"), { headers: { Authorization: authorization } })).status, 401, authorization);
    }
    assert.deepEqual(await readdir(dir).catch(() => []), [], "nothing was stored by unauthenticated requests");

    const accepted = await upload(url, utf8("x"), { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(accepted.status, 201);
    assert.equal((await upload(url, utf8("y"), { headers: { Authorization: `bearer ${TOKEN}` } })).status, 201, "the scheme name is case-insensitive");

    assert.ok(logs.length > 0);
    assert.ok(logs.every((line) => !line.includes(TOKEN)), "the token never reaches the log");
  });

  test("reading stays public, and the token is accepted as a Secret from the configuration", async (t) => {
    const config = loadConfig({ UPLOAD_TOKEN: TOKEN, IPFS_LOCAL_DIR: await temporaryDirectory(t), IPFS_SERVICE_PORT: "0" });
    const service = createUploadService({ storage: createStorage(config), ...config.service });
    const { url } = await service.listen();
    t.after(() => service.close({ graceMs: 200 }));

    assert.equal((await upload(url, utf8("x"))).status, 401);
    const stored = await upload(url, utf8("x"), { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(stored.status, 201);
    const { cid } = await stored.json();
    assert.equal((await fetch(`${url}/ipfs/${cid}`)).status, 200, "no token needed to read");
    assert.equal((await fetch(`${url}/health`)).status, 200);
  });

  test("the origin check and the token check both apply", async (t) => {
    const { url } = await startService(t, { service: { uploadToken: TOKEN } });
    const headers = { Authorization: `Bearer ${TOKEN}` };
    assert.equal((await upload(url, utf8("x"), { headers: { ...headers, Origin: "https://evil.example" } })).status, 403);
    assert.equal((await upload(url, utf8("x"), { headers: { Origin: ALLOWED_ORIGIN } })).status, 401);
    assert.equal((await upload(url, utf8("x"), { headers: { ...headers, Origin: ALLOWED_ORIGIN } })).status, 201);
  });
});

describe("path handling", () => {
  test("no path-traversal attempt in the cid segment reaches the file system", async (t) => {
    const parent = await temporaryDirectory(t);
    const dir = path.join(parent, "store");
    await mkdir(dir);
    // Canaries: a file next to the store directory, and a non-CID file inside it.
    await writeFile(path.join(parent, "secret.txt"), "CANARY-OUTSIDE-THE-STORE");
    await writeFile(path.join(dir, "notes.txt"), "CANARY-INSIDE-THE-STORE");
    const { url } = await startService(t, { dir });
    const { cid } = await (await upload(url, utf8("legitimate content"))).json();

    const attempts = [
      "/ipfs/../secret.txt",
      "/ipfs/..%2Fsecret.txt",
      "/ipfs/%2e%2e%2fsecret.txt",
      "/ipfs/%2e%2e/secret.txt",
      "/ipfs/..%5Csecret.txt",
      "/ipfs/....//secret.txt",
      "/ipfs/../../../../../../etc/passwd",
      "/ipfs/..%2F..%2F..%2F..%2Fetc%2Fpasswd",
      "/ipfs/%2Fetc%2Fpasswd",
      "/ipfs//etc/passwd",
      "/ipfs/notes.txt",
      "/ipfs/./notes.txt",
      "/ipfs/.",
      "/ipfs/..",
      `/ipfs/${cid}/../notes.txt`,
      `/ipfs/${cid}%2F..%2Fnotes.txt`,
      `/ipfs/${cid}/`,
      `/ipfs/${cid}%00`,
      `/ipfs/${cid}%00.txt`,
      `/ipfs/${cid}%0a`,
      `/ipfs/%20${cid}`,
      `/ipfs/${cid.toUpperCase()}`,
      "/ipfs/%ZZ",
      "/ipfs/%",
      "/ipfs/%C0%AE%C0%AE%2Fsecret.txt",
      "/ipfs/file:%2F%2F%2Fetc%2Fpasswd",
      "/ipfs/C:%5CWindows%5Cwin.ini",
    ];
    for (const target of attempts) {
      for (const method of ["GET", "HEAD"]) {
        const response = await rawRequest(url, { method, path: target });
        assert.equal(response.status, 400, `${method} ${target}`);
        assert.ok(!response.body.includes("CANARY"), `${target} leaked a file`);
      }
    }
    // A path that leaves /ipfs/ entirely is simply not a route.
    assert.equal((await rawRequest(url, { path: "/../secret.txt" })).status, 404);
    assert.equal((await rawRequest(url, { path: "/ipfs%2F..%2Fsecret.txt" })).status, 404);
    // And the legitimate request still works afterwards.
    assert.equal((await rawRequest(url, { path: `/ipfs/${cid}` })).body.toString(), "legitimate content");
  });

  test("a percent-encoded but otherwise valid CID is accepted", async (t) => {
    const { url } = await startService(t);
    const { cid } = await (await upload(url, utf8("encoded path"))).json();
    const encoded = `%62${cid.slice(1)}`; // "%62" is "b"
    assert.equal((await rawRequest(url, { path: `/ipfs/${encoded}` })).body.toString(), "encoded path");
  });

  test("the query string is ignored for routing and never used as a path", async (t) => {
    const { url } = await startService(t);
    const { cid } = await (await upload(url, utf8("query"))).json();
    assert.equal((await rawRequest(url, { path: `/ipfs/${cid}?filename=../../x&download=true` })).status, 200);
    assert.equal((await rawRequest(url, { path: "/health?x=/ipfs/../../etc/passwd" })).status, 200);
  });
});

describe("lifecycle", () => {
  test("close() lets a request in progress finish, then refuses new connections", async (t) => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const storage = {
      name: "slow",
      get: async () => {
        await gate;
        return utf8("slow but complete");
      },
    };
    const { url, service } = await startService(t, { storage });

    const inFlight = fetch(`${url}/ipfs/${computeRawCid(utf8("x"))}`);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the request reach the handler
    const closing = service.close({ graceMs: 5000 });
    release();

    const response = await inFlight;
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "slow but complete");
    await closing;
    await assert.rejects(fetch(`${url}/health`), "the port is closed");
    await service.close(); // closing twice is harmless
  });

  test("close() cuts connections that are still open after the grace period", async (t) => {
    const storage = { name: "stuck", get: () => new Promise(() => {}) };
    const { url, service } = await startService(t, { storage });
    const stuck = fetch(`${url}/ipfs/${computeRawCid(utf8("x"))}`).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const started = Date.now();
    await service.close({ graceMs: 100 });
    assert.ok(Date.now() - started < 2000, "shutdown did not wait for the stuck request");
    assert.ok((await stuck) instanceof Error);
  });

  test("listen() explains a port that is already in use", async (t) => {
    const first = await startService(t);
    const port = Number(new URL(first.url).port);
    const second = createUploadService({ storage: first.storage, port });
    await assert.rejects(second.listen(), (error) => error instanceof OracleError && error.code === "SERVICE_LISTEN_FAILED" && /already in use/.test(error.message) && /IPFS_SERVICE_PORT/.test(error.message));
  });

  test("one log line per request: method, path without query, status", async (t) => {
    const { url, logs } = await startService(t);
    await upload(url, utf8("logged"), { name: "private-name.json" });
    await fetch(`${url}/ipfs/not-a-cid`);
    await fetch(`${url}/health`);
    assert.deepEqual(logs, ["POST /upload 201", "GET /ipfs/not-a-cid 400", "GET /health 200"]);
  });

  test("a hostile path cannot flood the log or put terminal control bytes into it", async (t) => {
    const { url, logs } = await startService(t);
    await rawRequest(url, { path: `/ipfs/${"a".repeat(5000)}` });
    assert.deepEqual(logs, [`GET /ipfs/${"a".repeat(194)}... 400`], "a long path is cut to 200 characters");

    // An ANSI escape sequence in the request line: refused as malformed HTTP before any handler or log line.
    const { connect } = await import("node:net");
    const statusLine = await new Promise((resolve, reject) => {
      const socket = connect(Number(new URL(url).port), "127.0.0.1", () => socket.write("GET /ipfs/a\x1b[31mred HTTP/1.1\r\nHost: x\r\n\r\n"));
      let received = "";
      socket.on("data", (chunk) => (received += chunk));
      socket.on("end", () => resolve(received.split("\r\n")[0]));
      socket.on("error", reject);
    });
    assert.equal(statusLine, "HTTP/1.1 400 Bad Request");
    assert.equal(logs.length, 1);
  });
});

describe("UploadServiceClient", () => {
  test("health, add, get and has against a running service", async (t) => {
    const { url } = await startService(t);
    const client = new UploadServiceClient({ baseUrl: `${url}/` });
    const bytes = utf8('{"via": "client"}\n');

    assert.deepEqual(await client.health(), { ok: true, backend: "local", maxUploadBytes: 1048576 });
    const stored = await client.add(bytes, { name: "via client.json" });
    assert.deepEqual(stored, { cid: computeRawCid(bytes), contentHash: computeContentHash(bytes), size: bytes.length });
    assert.deepEqual(await client.get(stored.cid), bytes);
    assert.equal(await client.has(stored.cid), true);
    assert.equal(await client.has(computeRawCid(utf8("absent"))), false);
    assert.equal(client.urlFor(stored.cid), `${url}/ipfs/${stored.cid}`);
    await assert.rejects(client.get(computeRawCid(utf8("absent"))), NotFoundError);
  });

  test("sends the upload token only with uploads", async (t) => {
    const seen = [];
    const bytes = utf8("x");
    const mock = await startMockServer(t, (request, response) => {
      seen.push([request.method, request.url, request.headers.authorization]);
      if (request.method === "POST") {
        response.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ cid: computeRawCid(bytes), contentHash: computeContentHash(bytes), size: 1 }));
      } else {
        response.writeHead(200, { "Content-Type": "application/json" }).end(request.url === "/health" ? JSON.stringify({ ok: true }) : bytes);
      }
    });
    const client = new UploadServiceClient({ baseUrl: mock.url, token: TOKEN });
    await client.add(bytes, { name: "a b.json" });
    await client.get(computeRawCid(bytes));
    await client.has(computeRawCid(bytes));
    await client.health();
    assert.deepEqual(seen, [
      ["POST", "/upload?name=a%20b.json", `Bearer ${TOKEN}`],
      ["GET", `/ipfs/${computeRawCid(bytes)}`, undefined],
      ["HEAD", `/ipfs/${computeRawCid(bytes)}`, undefined],
      ["GET", "/health", undefined],
    ]);
    assert.ok(!JSON.stringify(client).includes(TOKEN));
  });

  test("reports the service's error message and status", async (t) => {
    const withToken = await startService(t, { service: { uploadToken: TOKEN, maxUploadBytes: 64 } });
    await assert.rejects(new UploadServiceClient({ baseUrl: withToken.url }).add(utf8("x")), (error) => error instanceof ServiceRequestError && error.status === 401 && /upload token is required/.test(error.message));
    await assert.rejects(
      new UploadServiceClient({ baseUrl: withToken.url, token: TOKEN }).add(new Uint8Array(65).fill(1)),
      (error) => error instanceof ServiceRequestError && error.status === 413 && /64-byte limit/.test(error.message),
    );
    assert.equal((await new UploadServiceClient({ baseUrl: withToken.url, token: TOKEN }).add(new Uint8Array(64).fill(1))).size, 64);
  });

  test("does not trust the service: a wrong hash, size or CID in the answer is rejected", async (t) => {
    const bytes = utf8("what I sent");
    const honest = { cid: computeRawCid(bytes), contentHash: computeContentHash(bytes), size: bytes.length };
    const lies = [
      { ...honest, contentHash: computeContentHash(utf8("something else")) },
      { ...honest, size: honest.size + 1 },
      { ...honest, cid: computeRawCid(utf8("something else")) },
    ];
    for (const answer of lies) {
      const mock = await startMockServer(t, (_request, response) => response.writeHead(201).end(JSON.stringify(answer)));
      await assert.rejects(new UploadServiceClient({ baseUrl: mock.url }).add(bytes), IntegrityError);
    }
    const garbage = await startMockServer(t, (_request, response) => response.writeHead(201).end(JSON.stringify({ ok: true })));
    await assert.rejects(new UploadServiceClient({ baseUrl: garbage.url }).add(bytes), ServiceRequestError);

    const swapped = await startMockServer(t, (_request, response) => response.writeHead(200).end("not what the CID names"));
    await assert.rejects(new UploadServiceClient({ baseUrl: swapped.url }).get(honest.cid), IntegrityError);
  });

  test("explains an unreachable service", async (t) => {
    const { url, service } = await startService(t);
    await service.close();
    await assert.rejects(new UploadServiceClient({ baseUrl: url }).health(), (error) => error instanceof ServiceRequestError && /cannot be reached/.test(error.message) && /npm run service/.test(error.message));
  });

  test("works as a storage backend for code written against { add, get, has }", async (t) => {
    const { url } = await startService(t);
    /** @param {{ add: Function, get: Function, has: Function }} storage */
    const roundTrip = async (storage) => {
      const { cid, contentHash } = await storage.add(utf8("same code, either transport"));
      assert.equal(await storage.has(cid), true);
      return computeContentHash(await storage.get(cid)) === contentHash;
    };
    assert.equal(await roundTrip(new UploadServiceClient({ baseUrl: url })), true);
    assert.equal(await roundTrip(new LocalBackend({ store: new LocalStore({ dir: await temporaryDirectory(t) }) })), true);
  });
});
