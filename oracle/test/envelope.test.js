/**
 * Tests for src/crypto/envelope.js: the AES-256-GCM envelope for confidential
 * documents (design decision O5).
 *
 * Besides round trips, the envelope is checked against an independent
 * implementation in both directions: node:crypto (OpenSSL's AES-GCM, a
 * different API from the WebCrypto code under test) must be able to open an
 * envelope made here, and the code under test must open an envelope
 * assembled by hand with node:crypto. That pins the byte layout, so the
 * browser and any other implementation can interoperate.
 *
 * Every key in this file is generated at run time or is an obviously
 * synthetic pattern; none protects anything.
 */

import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import {
  ENCRYPTION_DESCRIPTOR,
  ENCRYPTION_SCHEME,
  ENVELOPE_VERSION,
  EnvelopeError,
  HEADER_BYTES,
  IV_BYTES,
  KEY_BYTES,
  TAG_BYTES,
  decodeKey,
  decrypt,
  encodeKey,
  encrypt,
  generateKey,
  inspectEnvelope,
} from "../src/crypto/envelope.js";
import { computeContentHash, computeRawCid, verifyContent } from "../src/ipfs/cid.js";

const utf8 = (text) => new TextEncoder().encode(text);
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const hasCode = (code) => (error) => error instanceof EnvelopeError && error.code === code;

describe("encryption envelope v1", () => {
  test("round trip returns the original bytes", async () => {
    const plaintext = utf8("Certificate of analysis (synthetic): assay 100.4 mg/mL");
    const key = generateKey();
    const envelope = await encrypt(plaintext, key);
    assert.deepEqual(await decrypt(envelope, key), plaintext);
  });

  test("round trips binary data, an empty document and a 1 MiB document", async () => {
    const key = generateKey();
    for (const plaintext of [new Uint8Array(0), Uint8Array.from({ length: 256 }, (_, i) => i), new Uint8Array(randomBytes(1048576))]) {
      const envelope = await encrypt(plaintext, key);
      assert.equal(envelope.length, plaintext.length + HEADER_BYTES + TAG_BYTES);
      assert.equal(hex(await decrypt(envelope, key)), hex(plaintext));
    }
  });

  test("layout: version byte 0x01, 12-byte IV, then ciphertext and 16-byte tag", async () => {
    const plaintext = utf8("layout check");
    const envelope = await encrypt(plaintext, generateKey());

    assert.equal(ENVELOPE_VERSION, 1);
    assert.equal(IV_BYTES, 12);
    assert.equal(TAG_BYTES, 16);
    assert.equal(KEY_BYTES, 32);
    assert.equal(HEADER_BYTES, 13);
    assert.equal(envelope[0], 0x01);
    assert.equal(envelope.length, 1 + 12 + plaintext.length + 16, "GCM adds no padding: only header and tag");

    const parts = inspectEnvelope(envelope);
    assert.equal(parts.version, 1);
    assert.equal(hex(parts.iv), hex(envelope.subarray(1, 13)));
    assert.equal(hex(parts.sealed), hex(envelope.subarray(13)));
    assert.equal(parts.plaintextLength, plaintext.length);
    assert.deepEqual(ENCRYPTION_DESCRIPTOR, { scheme: "AES-256-GCM", envelope: 1 });
    assert.equal(ENCRYPTION_SCHEME, "AES-256-GCM");
  });

  test("an independent AES-256-GCM implementation opens an envelope made here", async () => {
    const plaintext = utf8("interoperability: WebCrypto -> OpenSSL");
    const key = generateKey();
    const envelope = await encrypt(plaintext, key);

    const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(1, 13));
    decipher.setAuthTag(envelope.subarray(envelope.length - 16));
    const opened = Buffer.concat([decipher.update(envelope.subarray(13, envelope.length - 16)), decipher.final()]);
    assert.equal(opened.toString("utf8"), "interoperability: WebCrypto -> OpenSSL");
  });

  test("an envelope assembled by an independent implementation opens here", async () => {
    const plaintext = utf8("interoperability: OpenSSL -> WebCrypto");
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = Buffer.concat([Buffer.from([0x01]), iv, ciphertext, cipher.getAuthTag()]);

    assert.deepEqual(await decrypt(new Uint8Array(envelope), new Uint8Array(key)), plaintext);
  });

  test("every encryption uses a fresh IV, so equal plaintexts give different envelopes", async () => {
    const key = generateKey();
    const plaintext = utf8("same document");
    const envelopes = await Promise.all(Array.from({ length: 20 }, () => encrypt(plaintext, key)));
    assert.equal(new Set(envelopes.map((envelope) => hex(envelope.subarray(1, 13)))).size, 20, "20 distinct IVs");
    assert.equal(new Set(envelopes.map(hex)).size, 20);
  });

  test("the ciphertext does not contain the plaintext", async () => {
    const plaintext = utf8("CONFIDENTIAL-MARKER-0123456789");
    const envelope = await encrypt(plaintext, generateKey());
    assert.ok(!Buffer.from(envelope).includes(Buffer.from(plaintext)));
  });

  test("the wrong key is rejected", async () => {
    const envelope = await encrypt(utf8("secret"), generateKey());
    await assert.rejects(decrypt(envelope, generateKey()), hasCode("ENVELOPE_AUTH_FAILED"));
  });

  test("a change to any part of the envelope is detected", async () => {
    const key = generateKey();
    const envelope = await encrypt(utf8("pricing: 12.50 per vial"), key);
    const positions = {
      "the IV": 1,
      "the last IV byte": 12,
      "the first ciphertext byte": 13,
      "a middle ciphertext byte": 20,
      "the first tag byte": envelope.length - 16,
      "the last tag byte": envelope.length - 1,
    };
    for (const [label, index] of Object.entries(positions)) {
      const tampered = Uint8Array.from(envelope);
      tampered[index] ^= 0x01;
      await assert.rejects(decrypt(tampered, key), hasCode("ENVELOPE_AUTH_FAILED"), label);
    }
    await assert.rejects(decrypt(envelope.subarray(0, envelope.length - 1), key), hasCode("ENVELOPE_AUTH_FAILED"), "truncated");
    await assert.rejects(decrypt(Uint8Array.from([...envelope, 0]), key), hasCode("ENVELOPE_AUTH_FAILED"), "extended");
  });

  test("an unknown version byte or a file too short to be an envelope is refused before decrypting", async () => {
    const key = generateKey();
    const envelope = await encrypt(utf8("x"), key);
    const futureVersion = Uint8Array.from(envelope);
    futureVersion[0] = 0x02;
    await assert.rejects(decrypt(futureVersion, key), hasCode("ENVELOPE_VERSION"));
    await assert.rejects(decrypt(utf8('{"type": "sensor-log"} is plaintext, not an envelope'), key), hasCode("ENVELOPE_VERSION"));
    await assert.rejects(decrypt(new Uint8Array(28), key), hasCode("ENVELOPE_MALFORMED"));
    await assert.rejects(decrypt(new Uint8Array(0), key), hasCode("ENVELOPE_MALFORMED"));
    assert.throws(() => inspectEnvelope(new Uint8Array(5)), hasCode("ENVELOPE_MALFORMED"));
  });

  test("keys travel as 43 characters of unpadded base64url", async () => {
    const key = generateKey();
    const encoded = encodeKey(key);
    assert.match(encoded, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(hex(decodeKey(encoded)), hex(key));
    assert.equal(hex(decodeKey(`${encoded}=`)), hex(key), "one padding character is tolerated");
    assert.equal(hex(decodeKey(`  ${encoded}\n`)), hex(key), "surrounding white space from a key file is ignored");

    // 32 bytes of 0xfb / 0xff exercise the two characters that differ from standard base64.
    assert.equal(encodeKey(new Uint8Array(32).fill(0xfb)), "-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_s");
    assert.equal(encodeKey(new Uint8Array(32).fill(0xff)), "__________________________________________8");

    const envelope = await encrypt(utf8("text key"), encoded);
    assert.deepEqual(await decrypt(envelope, encoded), utf8("text key"), "the text form works wherever a key is expected");
    assert.deepEqual(await decrypt(envelope, key), utf8("text key"));
  });

  test("malformed keys are rejected without echoing them", async () => {
    const candidates = ["", "short", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}+`, `${"A".repeat(42)}/`, "0x" + "ab".repeat(32), 12345, null];
    for (const candidate of candidates) {
      assert.throws(
        () => decodeKey(candidate),
        (error) => hasCode("ENVELOPE_KEY_INVALID")(error) && (typeof candidate !== "string" || candidate.length < 8 || !error.message.includes(candidate)),
      );
    }
    for (const wrongSize of [new Uint8Array(16), new Uint8Array(31), new Uint8Array(33), new Uint8Array(0)]) {
      await assert.rejects(encrypt(utf8("x"), wrongSize), hasCode("ENVELOPE_KEY_INVALID"));
      assert.throws(() => encodeKey(wrongSize), hasCode("ENVELOPE_KEY_INVALID"));
    }
    await assert.rejects(decrypt(await encrypt(utf8("x"), generateKey()), "not a key"), hasCode("ENVELOPE_KEY_INVALID"));
  });

  test("generated keys are 32 bytes and differ from one another", () => {
    const keys = Array.from({ length: 50 }, () => generateKey());
    assert.ok(keys.every((key) => key instanceof Uint8Array && key.length === 32));
    assert.equal(new Set(keys.map(hex)).size, 50);
  });

  test("the public hash and CID cover the encrypted bytes, so integrity is checkable without the key", async () => {
    const plaintext = utf8("confidential attachment");
    const key = generateKey();
    const envelope = await encrypt(plaintext, key);
    const ref = { cid: computeRawCid(envelope), contentHash: computeContentHash(envelope) };

    assert.equal(verifyContent(envelope, ref).ok, true, "anyone can verify the stored file");
    assert.notEqual(ref.contentHash, computeContentHash(plaintext), "the hash reveals nothing about the plaintext hash");
    const tampered = Uint8Array.from(envelope);
    tampered[tampered.length - 1] ^= 1;
    assert.equal(verifyContent(tampered, ref).ok, false);
  });

  test("the module is browser-compatible: it has no imports", async () => {
    const source = await readFile(new URL("../src/crypto/envelope.js", import.meta.url), "utf8");
    assert.ok(!/^\s*import\s/m.test(source), "no static import statements");
    assert.ok(!/\bimport\s*\(/.test(source), "no dynamic imports");
    assert.ok(!/\brequire\s*\(/.test(source), "no require calls");
    assert.ok(!/\b(Buffer|process)\b\./.test(source), "no Node-only globals");
  });
});
