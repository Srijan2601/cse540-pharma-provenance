/**
 * Tests for the storage layer: the local directory, the three backends, the
 * write-through cache and the gateway fallback.
 *
 * The remote backends are tested against local mock HTTP servers that assert
 * the exact request each backend sends. No request leaves the machine and no
 * real credential is involved; the "JWT" below is a made-up string.
 */

import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { inspect } from "node:util";

import { loadConfig } from "../src/config.js";
import {
  ContentTooLargeError,
  IntegrityError,
  InvalidCidError,
  InvalidContentError,
  NotFoundError,
  StorageError,
} from "../src/errors.js";
import {
  GatewayClient,
  KuboBackend,
  LocalBackend,
  LocalStore,
  MAX_RAW_BLOCK_BYTES,
  PinataBackend,
  computeContentHash,
  computeRawCid,
  createStorage,
  sanitizeFileName,
} from "../src/ipfs/index.js";
import { normalizeGatewayUrl } from "../src/ipfs/gateway.js";
import { multipartOf, startMockServer, temporaryDirectory } from "./helpers/harness.js";

const utf8 = (text) => new TextEncoder().encode(text);
const text = (bytes) => new TextDecoder().decode(bytes);

/** A made-up token in JWT shape; it authenticates nothing. */
const FAKE_JWT = "aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb.cccccccccccc";
/** A dag-pb CIDv1 and a CIDv0, as a node returns for a file larger than one chunk. */
const DAG_PB_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CIDV0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CIDV0_AS_V1 = "bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34";

/**
 * A mock gateway that serves the given CID -> bytes map and fails the test if
 * any request carries a credential.
 */
async function startMockGateway(t, files) {
  return startMockServer(t, (request, response) => {
    assert.equal(request.headers.authorization, undefined, "no credential may ever be sent to a gateway");
    assert.equal(request.headers.cookie, undefined);
    const cid = request.url.replace(/^\/ipfs\//, "");
    if (!files.has(cid)) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(request.method === "HEAD" ? undefined : files.get(cid));
  });
}

describe("LocalStore", () => {
  test("stores a file under its CID and reads it back", async (t) => {
    const store = new LocalStore({ dir: await temporaryDirectory(t) });
    const bytes = utf8("sensor log bytes");
    const cid = computeRawCid(bytes);

    assert.equal(await store.has(cid), false);
    await store.put(cid, bytes);
    assert.equal(await store.has(cid), true);
    assert.equal(text(await store.get(cid)), "sensor log bytes");
    assert.deepEqual(await readdir(store.dir), [cid], "one file named after the CID, no temporary files left behind");
  });

  test("creates the directory on first write, including missing parents", async (t) => {
    const dir = path.join(await temporaryDirectory(t), "nested", "store");
    const store = new LocalStore({ dir });
    const bytes = utf8("x");
    await store.put(computeRawCid(bytes), bytes);
    assert.equal(text(await store.get(computeRawCid(bytes))), "x");
  });

  test("reports a missing CID as NotFoundError, also before the directory exists", async (t) => {
    const store = new LocalStore({ dir: path.join(await temporaryDirectory(t), "never-created") });
    const cid = computeRawCid(utf8("absent"));
    await assert.rejects(store.get(cid), NotFoundError);
    assert.equal(await store.has(cid), false);
  });

  test("refuses to store bytes under a raw CID they do not hash to", async (t) => {
    const store = new LocalStore({ dir: await temporaryDirectory(t) });
    await assert.rejects(store.put(computeRawCid(utf8("original")), utf8("different")), IntegrityError);
    assert.deepEqual(await readdir(store.dir).catch(() => []), []);
  });

  test("detects a file that was edited on disk and never returns it", async (t) => {
    const store = new LocalStore({ dir: await temporaryDirectory(t) });
    const bytes = utf8('{"tenthsC": 54}\n');
    const cid = computeRawCid(bytes);
    await store.put(cid, bytes);

    await writeFile(store.pathFor(cid), '{"tenthsC": 94}\n');
    await assert.rejects(store.get(cid), IntegrityError);
  });

  test("keeps a CIDv0 and its CIDv1 form in one file with a case-insensitive-safe name", async (t) => {
    const store = new LocalStore({ dir: await temporaryDirectory(t) });
    await store.put(CIDV0, utf8("a chunked file"));
    assert.deepEqual(await readdir(store.dir), [CIDV0_AS_V1]);
    assert.equal(text(await store.get(CIDV0_AS_V1)), "a chunked file");
    assert.equal(text(await store.get(CIDV0)), "a chunked file");
  });

  test("never builds a path from text that is not a CID", async (t) => {
    const store = new LocalStore({ dir: await temporaryDirectory(t) });
    for (const hostile of ["../outside", "..", "/etc/passwd", "a/b", "bafk/../x", ".tmp-x", ""]) {
      assert.throws(() => store.pathFor(hostile), InvalidCidError, hostile);
      await assert.rejects(store.get(hostile), InvalidCidError);
      await assert.rejects(store.has(hostile), InvalidCidError);
      await assert.rejects(store.put(hostile, utf8("x")), InvalidCidError);
    }
  });
});

describe("LocalBackend", () => {
  test("add returns { cid, contentHash, size } for the exact bytes and get returns them", async (t) => {
    const backend = new LocalBackend({ store: new LocalStore({ dir: await temporaryDirectory(t) }) });
    const bytes = utf8('{\n  "a": 1\n}\n');

    const stored = await backend.add(bytes, { name: "doc.json" });
    assert.deepEqual(stored, { cid: computeRawCid(bytes), contentHash: computeContentHash(bytes), size: bytes.length });
    assert.equal(stored.cid, "bafkreic6g23fmbitlbwo2zpmudulajp6rdw3zk4cxiwlm6s7zmwxwibdqm", "the CID a real IPFS node gives this file");
    assert.equal(await backend.has(stored.cid), true);
    assert.deepEqual(await backend.get(stored.cid), bytes);
    assert.equal(backend.name, "local");
  });

  test("adding the same bytes twice is idempotent", async (t) => {
    const backend = new LocalBackend({ store: new LocalStore({ dir: await temporaryDirectory(t) }) });
    const first = await backend.add(utf8("same"));
    const second = await backend.add(utf8("same"));
    assert.deepEqual(first, second);
    assert.equal((await readdir(backend.store.dir)).length, 1);
  });

  test("accepts exactly 1 MiB and rejects one byte more", async (t) => {
    const backend = new LocalBackend({ store: new LocalStore({ dir: await temporaryDirectory(t) }) });
    const atLimit = await backend.add(new Uint8Array(MAX_RAW_BLOCK_BYTES));
    assert.equal(atLimit.size, 1048576);
    await assert.rejects(
      backend.add(new Uint8Array(MAX_RAW_BLOCK_BYTES + 1)),
      (error) => error instanceof ContentTooLargeError && error.limit === 1048576,
    );
  });

  test("a requested limit above 1 MiB is capped: one block is the most this backend can address", async (t) => {
    const backend = new LocalBackend({ store: new LocalStore({ dir: await temporaryDirectory(t) }), maxBytes: 10 * MAX_RAW_BLOCK_BYTES });
    assert.equal(backend.maxBytes, MAX_RAW_BLOCK_BYTES);
  });

  test("rejects empty content and non-byte input", async (t) => {
    const backend = new LocalBackend({ store: new LocalStore({ dir: await temporaryDirectory(t) }) });
    await assert.rejects(backend.add(new Uint8Array(0)), InvalidContentError);
    await assert.rejects(backend.add("a string"), InvalidContentError);
  });

  test("unknown and malformed CIDs", async (t) => {
    const backend = new LocalBackend({ store: new LocalStore({ dir: await temporaryDirectory(t) }) });
    await assert.rejects(backend.get(computeRawCid(utf8("never stored"))), NotFoundError);
    assert.equal(await backend.has(computeRawCid(utf8("never stored"))), false);
    await assert.rejects(backend.get("../../etc/passwd"), InvalidCidError);
  });
});

describe("KuboBackend", () => {
  test("sends the documented add request and returns the node's CID", async (t) => {
    const bytes = utf8("certificate bytes");
    const cid = computeRawCid(bytes);
    const kubo = await startMockServer(t, async (request, response) => {
      const form = await multipartOf(request);
      const file = form.get("file");
      assert.deepEqual([...form.keys()], ["file"], "exactly one multipart part");
      assert.equal(file.name, "certificate.json");
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes, "the bytes arrive unchanged");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(`${JSON.stringify({ Name: "certificate.json", Hash: cid, Size: String(bytes.length) })}\n`);
    });
    const backend = new KuboBackend({ apiUrl: `${kubo.url}/`, store: new LocalStore({ dir: await temporaryDirectory(t) }) });

    const stored = await backend.add(bytes, { name: "certificate.json" });

    assert.deepEqual(stored, { cid, contentHash: computeContentHash(bytes), size: bytes.length });
    assert.equal(kubo.requests.length, 1);
    const [request] = kubo.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/v0/add?cid-version=1&raw-leaves=true&pin=true");
    assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(backend.name, "kubo");
  });

  test("writes every upload through to the local directory, so reads survive the node going away", async (t) => {
    const bytes = utf8("pinned on kubo");
    const kubo = await startMockServer(t, (_request, response) => {
      response.writeHead(200).end(JSON.stringify({ Name: "f", Hash: computeRawCid(bytes), Size: "14" }));
    });
    const dir = await temporaryDirectory(t);
    const backend = new KuboBackend({ apiUrl: kubo.url, store: new LocalStore({ dir }) });
    const { cid } = await backend.add(bytes);

    await kubo.close();

    assert.deepEqual(await readdir(dir), [cid]);
    assert.equal(text(await backend.get(cid)), "pinned on kubo");
    assert.equal(await backend.has(cid), true);
    assert.equal(kubo.requests.length, 1, "reading did not contact the node");
    await assert.rejects(backend.add(utf8("another file")), (error) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.backend, "kubo");
      assert.match(error.message, /cannot be reached/);
      assert.match(error.message, /IPFS_BACKEND=local/, "the message says how to fall back");
      return true;
    });
  });

  test("accepts the dag-pb CID a node returns for a multi-chunk file and caches the file under it", async (t) => {
    const bytes = utf8("stands in for a file larger than one chunk");
    const kubo = await startMockServer(t, (_request, response) => {
      response.writeHead(200).end(JSON.stringify({ Name: "big.bin", Hash: DAG_PB_CID, Size: "300000" }));
    });
    const backend = new KuboBackend({ apiUrl: kubo.url, store: new LocalStore({ dir: await temporaryDirectory(t) }) });

    const stored = await backend.add(bytes);
    assert.equal(stored.cid, DAG_PB_CID, "the remote CID is authoritative");
    assert.equal(stored.contentHash, computeContentHash(bytes), "the content hash is always of the exact bytes");
    assert.deepEqual(await backend.get(DAG_PB_CID), bytes);
  });

  test("uses the last line when the node answers with several JSON lines", async (t) => {
    const bytes = utf8("x");
    const kubo = await startMockServer(t, (_request, response) => {
      response.writeHead(200).end(`${JSON.stringify({ Name: "x", Bytes: 1 })}\n${JSON.stringify({ Name: "x", Hash: computeRawCid(bytes), Size: "1" })}\n`);
    });
    const backend = new KuboBackend({ apiUrl: kubo.url, store: new LocalStore({ dir: await temporaryDirectory(t) }) });
    assert.equal((await backend.add(bytes)).cid, computeRawCid(bytes));
  });

  test("rejects a raw CID that does not match the uploaded bytes and stores nothing", async (t) => {
    const kubo = await startMockServer(t, (_request, response) => {
      response.writeHead(200).end(JSON.stringify({ Name: "f", Hash: computeRawCid(utf8("some other file")), Size: "1" }));
    });
    const dir = await temporaryDirectory(t);
    const backend = new KuboBackend({ apiUrl: kubo.url, store: new LocalStore({ dir }) });
    await assert.rejects(backend.add(utf8("my file")), IntegrityError);
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });

  test("turns error statuses and unusable answers into StorageError", async (t) => {
    const answers = [
      [500, JSON.stringify({ Message: "repo is locked", Code: 0, Type: "error" })],
      [200, "<html>not kubo</html>"],
      [200, JSON.stringify({ Name: "f" })],
      [200, JSON.stringify({ Name: "f", Hash: "definitely-not-a-cid" })],
    ];
    for (const [status, body] of answers) {
      const kubo = await startMockServer(t, (_request, response) => response.writeHead(status).end(body));
      const backend = new KuboBackend({ apiUrl: kubo.url, store: new LocalStore({ dir: await temporaryDirectory(t) }) });
      await assert.rejects(backend.add(utf8("x")), (error) => error instanceof StorageError && error.backend === "kubo", body);
    }
  });

  test("gives up on a node that does not answer in time", async (t) => {
    // A node that accepts the request and then stays silent.
    const silent = await startMockServer(t, () => {});
    const backend = new KuboBackend({ apiUrl: silent.url, store: new LocalStore({ dir: await temporaryDirectory(t) }), timeoutMs: 50 });
    await assert.rejects(backend.add(utf8("x")), (error) => error instanceof StorageError && /did not answer within 50 ms/.test(error.message));
  });
});

describe("PinataBackend", () => {
  test("sends the Files API v3 upload request with the JWT as a bearer token", async (t) => {
    const bytes = utf8("lot metadata bytes");
    const cid = computeRawCid(bytes);
    const pinata = await startMockServer(t, async (request, response) => {
      const form = await multipartOf(request);
      assert.deepEqual([...form.keys()].sort(), ["cid_version", "file", "name", "network"]);
      assert.equal(form.get("network"), "public", "the public IPFS network, not Pinata's private one");
      assert.equal(form.get("cid_version"), "v1");
      assert.equal(form.get("name"), "lot-metadata.json");
      assert.equal(form.get("file").name, "lot-metadata.json");
      assert.deepEqual(new Uint8Array(await form.get("file").arrayBuffer()), bytes);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: { id: "0190-synthetic", name: "lot-metadata.json", cid, size: bytes.length, number_of_files: 1, mime_type: "application/json", group_id: null } }));
    });
    const backend = new PinataBackend({
      jwt: FAKE_JWT,
      uploadUrl: `${pinata.url}/v3/files`,
      store: new LocalStore({ dir: await temporaryDirectory(t) }),
    });

    const stored = await backend.add(bytes, { name: "lot-metadata.json" });

    assert.deepEqual(stored, { cid, contentHash: computeContentHash(bytes), size: bytes.length });
    assert.equal(pinata.requests.length, 1);
    const [request] = pinata.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v3/files");
    assert.equal(request.headers.authorization, `Bearer ${FAKE_JWT}`);
    assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.equal(backend.name, "pinata");
  });

  test("sends the JWT to the Pinata host only: never to the gateway", async (t) => {
    const mine = utf8("uploaded by me");
    const theirs = utf8("pinned by another organization");
    const theirCid = computeRawCid(theirs);
    const seenByPinata = [];
    const pinata = await startMockServer(t, (request, response) => {
      seenByPinata.push(request.headers.authorization);
      response.writeHead(200).end(JSON.stringify({ data: { cid: computeRawCid(mine) } }));
    });
    // startMockGateway fails the test if any request to it carries an Authorization header.
    const gateway = await startMockGateway(t, new Map([[theirCid, theirs]]));
    const backend = new PinataBackend({
      jwt: FAKE_JWT,
      uploadUrl: `${pinata.url}/v3/files`,
      store: new LocalStore({ dir: await temporaryDirectory(t) }),
      gateway: new GatewayClient({ baseUrl: `${gateway.url}/ipfs/` }),
    });

    await backend.add(mine);
    assert.deepEqual(await backend.get(theirCid), theirs);
    assert.equal(await backend.has(computeRawCid(utf8("nowhere"))), false);

    assert.deepEqual(seenByPinata, [`Bearer ${FAKE_JWT}`]);
    assert.equal(gateway.requests.length, 2, "one GET and one HEAD reached the gateway");
    for (const request of gateway.requests) {
      assert.equal(request.headers.authorization, undefined);
      assert.ok(!JSON.stringify(request.headers).includes(FAKE_JWT));
      assert.ok(!request.url.includes(FAKE_JWT));
    }
  });

  test("does not follow a redirect, which could carry the JWT to another host", async (t) => {
    const elsewhere = await startMockServer(t, (_request, response) => response.writeHead(200).end(JSON.stringify({ data: { cid: computeRawCid(utf8("x")) } })));
    const pinata = await startMockServer(t, (_request, response) => response.writeHead(307, { Location: `${elsewhere.url}/v3/files` }).end());
    const backend = new PinataBackend({ jwt: FAKE_JWT, uploadUrl: `${pinata.url}/v3/files`, store: new LocalStore({ dir: await temporaryDirectory(t) }) });

    await assert.rejects(backend.add(utf8("x")), StorageError);
    assert.equal(elsewhere.requests.length, 0, "the redirect target was never contacted");
  });

  test("refuses to be configured with a plain-http endpoint on another machine", async (t) => {
    const store = new LocalStore({ dir: await temporaryDirectory(t) });
    assert.throws(() => new PinataBackend({ jwt: FAKE_JWT, uploadUrl: "http://uploads.pinata.example/v3/files", store }), /plain http/);
    assert.throws(() => new PinataBackend({ jwt: "", store }), /JWT/);
    assert.equal(new PinataBackend({ jwt: FAKE_JWT, store }).uploadUrl, "https://uploads.pinata.cloud/v3/files", "the default is the documented endpoint");
  });

  test("never reveals the JWT in errors, logs or serialized form", async (t) => {
    const pinata = await startMockServer(t, (request, response) => {
      // A service that echoes the credential back in its error body.
      response.writeHead(500).end(JSON.stringify({ error: `bad token ${request.headers.authorization}` }));
    });
    const backend = new PinataBackend({ jwt: FAKE_JWT, uploadUrl: `${pinata.url}/v3/files`, store: new LocalStore({ dir: await temporaryDirectory(t) }) });

    const error = await backend.add(utf8("x")).catch((caught) => caught);
    assert.ok(error instanceof StorageError);
    assert.equal(error.status, 500);
    for (const rendering of [error.message, error.stack, inspect(error, { depth: 5 }), inspect(backend, { depth: 5, showHidden: true }), JSON.stringify(backend)]) {
      assert.ok(!rendering.includes(FAKE_JWT), "the JWT must not appear");
    }

    await pinata.close();
    const unreachable = await backend.add(utf8("x")).catch((caught) => caught);
    assert.ok(unreachable instanceof StorageError);
    assert.ok(!inspect(unreachable, { depth: 5 }).includes(FAKE_JWT));
  });

  test("explains a rejected credential and other unusable answers", async (t) => {
    const cases = [
      [401, JSON.stringify({ error: { reason: "INVALID_CREDENTIALS" } }), /rejected the credential \(HTTP 401\).*PINATA_JWT/],
      [403, "", /rejected the credential \(HTTP 403\)/],
      [429, "rate limited", /HTTP 429/],
      [200, JSON.stringify({ data: {} }), /without a "data.cid" field/],
      [200, "not json", /without a "data.cid" field/],
    ];
    for (const [status, body, expected] of cases) {
      const pinata = await startMockServer(t, (_request, response) => response.writeHead(status).end(body));
      const backend = new PinataBackend({ jwt: FAKE_JWT, uploadUrl: `${pinata.url}/v3/files`, store: new LocalStore({ dir: await temporaryDirectory(t) }) });
      await assert.rejects(backend.add(utf8("x")), (error) => error instanceof StorageError && expected.test(error.message));
    }
  });

  test("writes every upload through to the local directory", async (t) => {
    const bytes = utf8("pinned on pinata");
    const pinata = await startMockServer(t, (_request, response) => response.writeHead(200).end(JSON.stringify({ data: { cid: computeRawCid(bytes) } })));
    const dir = await temporaryDirectory(t);
    const backend = new PinataBackend({ jwt: FAKE_JWT, uploadUrl: `${pinata.url}/v3/files`, store: new LocalStore({ dir }) });
    const { cid } = await backend.add(bytes);
    await pinata.close();
    assert.deepEqual(await readFile(path.join(dir, cid)), Buffer.from(bytes));
    assert.deepEqual(await backend.get(cid), bytes);
  });
});

describe("gateway fallback", () => {
  test("content missing locally is fetched from the gateway, verified, and cached", async (t) => {
    const bytes = utf8("only on the public network");
    const cid = computeRawCid(bytes);
    const gateway = await startMockGateway(t, new Map([[cid, bytes]]));
    const dir = await temporaryDirectory(t);
    const backend = new LocalBackend({ store: new LocalStore({ dir }), gateway: new GatewayClient({ baseUrl: gateway.url }) });

    assert.equal(await backend.has(cid), true, "has() asks the gateway when the file is not local");
    assert.deepEqual(await backend.get(cid), bytes);
    assert.equal(gateway.requests.at(-1).url, `/ipfs/${cid}`);
    assert.deepEqual(await readdir(dir), [cid], "the verified download was cached");

    await gateway.close();
    assert.deepEqual(await backend.get(cid), bytes, "the second read is served locally, with the gateway gone");
  });

  test("the local directory wins: the gateway is not contacted for content already stored", async (t) => {
    const gateway = await startMockGateway(t, new Map());
    const backend = new LocalBackend({ store: new LocalStore({ dir: await temporaryDirectory(t) }), gateway: new GatewayClient({ baseUrl: gateway.url }) });
    const { cid } = await backend.add(utf8("local first"));
    await backend.get(cid);
    assert.equal(await backend.has(cid), true);
    assert.equal(gateway.requests.length, 0);
  });

  test("rejects a gateway that returns different bytes for a raw CID", async (t) => {
    const cid = computeRawCid(utf8("the genuine certificate"));
    const gateway = await startMockGateway(t, new Map([[cid, utf8("a forged certificate")]]));
    const dir = await temporaryDirectory(t);
    const backend = new LocalBackend({ store: new LocalStore({ dir }), gateway: new GatewayClient({ baseUrl: gateway.url }) });

    await assert.rejects(backend.get(cid), (error) => error instanceof IntegrityError && /gateway/.test(error.message));
    assert.deepEqual(await readdir(dir).catch(() => []), [], "the forged bytes were not cached");
  });

  test("returns dag-pb content from the gateway without caching it, because it cannot be verified here", async (t) => {
    const bytes = utf8("a multi-chunk file");
    const gateway = await startMockGateway(t, new Map([[DAG_PB_CID, bytes]]));
    const dir = await temporaryDirectory(t);
    const backend = new LocalBackend({ store: new LocalStore({ dir }), gateway: new GatewayClient({ baseUrl: gateway.url }) });

    assert.deepEqual(await backend.get(DAG_PB_CID), bytes);
    assert.deepEqual(await readdir(dir).catch(() => []), []);
    await backend.get(DAG_PB_CID);
    assert.equal(gateway.requests.length, 2, "fetched again rather than trusted from a cache");
  });

  test("repairs a corrupted local copy from the gateway", async (t) => {
    const bytes = utf8("good bytes");
    const cid = computeRawCid(bytes);
    const gateway = await startMockGateway(t, new Map([[cid, bytes]]));
    const store = new LocalStore({ dir: await temporaryDirectory(t) });
    const backend = new LocalBackend({ store, gateway: new GatewayClient({ baseUrl: gateway.url }) });
    await backend.add(bytes);
    await writeFile(store.pathFor(cid), "bit rot");

    assert.deepEqual(await backend.get(cid), bytes);
    assert.deepEqual(await store.get(cid), bytes, "the local copy is good again");
  });

  test("without a gateway a corrupted local copy is an IntegrityError and a missing one is NotFoundError", async (t) => {
    const store = new LocalStore({ dir: await temporaryDirectory(t) });
    const backend = new LocalBackend({ store });
    const { cid } = await backend.add(utf8("good bytes"));
    await writeFile(store.pathFor(cid), "bit rot");
    await assert.rejects(backend.get(cid), IntegrityError);
    await assert.rejects(backend.get(computeRawCid(utf8("absent"))), NotFoundError);
  });

  test("distinguishes not found, gateway errors, unreachable gateways and oversized answers", async (t) => {
    const cid = computeRawCid(utf8("whatever"));
    const big = new Uint8Array(4096).fill(7);
    const bigCid = computeRawCid(big);
    const gateway = await startMockServer(t, (request, response) => {
      if (request.url.endsWith(bigCid)) {
        // No Content-Length (chunked), so only the streaming cap can stop this download.
        response.writeHead(200);
        response.write(big.subarray(0, 2048));
        response.end(big.subarray(2048));
      } else if (request.url.includes("error")) {
        response.writeHead(503).end();
      } else {
        response.writeHead(404).end();
      }
    });

    const client = new GatewayClient({ baseUrl: gateway.url, maxBytes: 1024 });
    await assert.rejects(client.get(cid), NotFoundError);
    assert.equal(await client.has(cid), false);
    await assert.rejects(client.get(bigCid), (error) => error instanceof StorageError && /larger than the 1024-byte limit/.test(error.message));

    const failing = new GatewayClient({ baseUrl: `${gateway.url}/error/` });
    await assert.rejects(failing.get(cid), (error) => error instanceof StorageError && error.status === 503);
    await assert.rejects(failing.has(cid), StorageError);

    await gateway.close();
    await assert.rejects(client.get(cid), (error) => error instanceof StorageError && /could not be reached/.test(error.message));
    await assert.rejects(client.get("../../etc/passwd"), InvalidCidError);
  });

  test("normalizes gateway URLs to a prefix ending in a slash", () => {
    assert.equal(normalizeGatewayUrl("https://ipfs.io"), "https://ipfs.io/ipfs/");
    assert.equal(normalizeGatewayUrl("https://ipfs.io/"), "https://ipfs.io/ipfs/");
    assert.equal(normalizeGatewayUrl("http://127.0.0.1:8787/ipfs"), "http://127.0.0.1:8787/ipfs/");
    assert.equal(normalizeGatewayUrl("https://gw.example/custom/prefix/"), "https://gw.example/custom/prefix/");
    for (const bad of ["ipfs.io", "ftp://ipfs.io/", "https://user:pw@gw.example/ipfs/", "https://gw.example/ipfs/?token=1", "https://gw.example/#x"]) {
      assert.throws(() => normalizeGatewayUrl(bad), TypeError, bad);
    }
    assert.equal(new GatewayClient({ baseUrl: "https://ipfs.io" }).urlFor(DAG_PB_CID), `https://ipfs.io/ipfs/${DAG_PB_CID}`);
  });
});

describe("createStorage", () => {
  test("builds the backend named by IPFS_BACKEND and wires the shared directory and gateway", async (t) => {
    const dir = await temporaryDirectory(t);

    const local = createStorage(loadConfig({ IPFS_LOCAL_DIR: dir }));
    assert.ok(local instanceof LocalBackend);
    assert.equal(local.store.dir, dir);
    assert.equal(local.gateway, null, "zero configuration means no network access at all");

    const kubo = createStorage(loadConfig({ IPFS_BACKEND: "kubo", IPFS_LOCAL_DIR: dir, KUBO_API_URL: "http://127.0.0.1:15001/" }));
    assert.ok(kubo instanceof KuboBackend);
    assert.equal(kubo.apiUrl, "http://127.0.0.1:15001");
    assert.equal(kubo.gateway.baseUrl, "http://127.0.0.1:8080/ipfs/");
    assert.equal(kubo.store.dir, dir);

    const pinata = createStorage(loadConfig({ IPFS_BACKEND: "pinata", IPFS_LOCAL_DIR: dir, PINATA_JWT: FAKE_JWT, IPFS_GATEWAY_URL: "https://gw.example" }));
    assert.ok(pinata instanceof PinataBackend);
    assert.equal(pinata.gateway.baseUrl, "https://gw.example/ipfs/");
    assert.ok(!inspect(pinata, { depth: 6, showHidden: true }).includes(FAKE_JWT));
  });

  test("the local backend works end to end from a default configuration", async (t) => {
    const storage = createStorage(loadConfig({ IPFS_LOCAL_DIR: await temporaryDirectory(t) }));
    const { cid, contentHash } = await storage.add(utf8("zero configuration"));
    assert.equal(computeContentHash(await storage.get(cid)), contentHash);
  });
});

describe("sanitizeFileName", () => {
  test("reduces any input to a short label without path or control characters", () => {
    assert.equal(sanitizeFileName("sensor-log_1.json"), "sensor-log_1.json");
    assert.equal(sanitizeFileName("../../etc/passwd"), "etc_passwd");
    assert.equal(sanitizeFileName("Certificate (final).pdf"), "Certificate_final_.pdf");
    assert.equal(sanitizeFileName('a"\r\nX-Injected: 1'), "a_X-Injected_1");
    assert.equal(sanitizeFileName(".hidden"), "hidden");
    assert.equal(sanitizeFileName("x".repeat(500)).length, 128);
    for (const empty of [undefined, null, 42, "", "///", "..."]) {
      assert.equal(sanitizeFileName(empty), "file");
    }
  });
});
