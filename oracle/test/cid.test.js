/**
 * Tests for src/ipfs/cid.js and src/ipfs/multibase.js: CID computation, CID
 * parsing, and verification of bytes against an on-chain DocumentRef.
 *
 * Where the expected CIDs come from. They were NOT produced by the code under
 * test. They were computed with the independent reference implementation
 * "multiformats" (npm, version 14.0.8), installed in a scratch directory
 * outside this repository:
 *
 *   CID.create(1, raw.code, await sha256.digest(bytes)).toString(base32)
 *
 * and cross-checked against a real IPFS node: Kubo 0.43.2
 * (`ipfs add --cid-version=1`) returned the same CID for "hello world\n" and
 * for other single-chunk files (see the README, "CIDs on real IPFS").
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { InvalidCidError, InvalidContentError } from "../src/errors.js";
import {
  CODEC_DAG_PB,
  CODEC_RAW,
  HASH_SHA2_256,
  MAX_CID_LENGTH,
  cidMatchesBytes,
  computeContentHash,
  computeRawCid,
  isCid,
  parseCid,
  sha256Digest,
  toBytes,
  verifyContent,
} from "../src/ipfs/cid.js";
import { base32Decode, base32Encode, base58Decode, varintDecode, varintEncode } from "../src/ipfs/multibase.js";

const utf8 = (text) => new TextEncoder().encode(text);
const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** Raw-codec CIDv1 vectors from multiformats 14.0.8 (see the file header). */
const RAW_CID_VECTORS = [
  { label: "empty input", bytes: new Uint8Array(0), cid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku" },
  { label: '"hello world\\n"', bytes: utf8("hello world\n"), cid: "bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4" },
  { label: '"hello"', bytes: utf8("hello"), cid: "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq" },
  {
    label: "a pretty-printed JSON document",
    bytes: utf8(`${JSON.stringify({ a: 1 }, null, 2)}\n`),
    cid: "bafkreic6g23fmbitlbwo2zpmudulajp6rdw3zk4cxiwlm6s7zmwxwibdqm",
  },
  {
    label: "every byte value 0..255",
    bytes: Uint8Array.from({ length: 256 }, (_, i) => i),
    cid: "bafkreicav7zotuwysixepl6umshgsz2jofmhqx55dwuhbzyrajtl7fciqa",
  },
  { label: "64 KiB of 0x61", bytes: new Uint8Array(65536).fill(0x61), cid: "bafkreif7ogfw6zj35payjykht4mtlog2s5gxag4jhl6pjhtqd47c7h44li" },
  { label: "1 MiB of zeros", bytes: new Uint8Array(1048576), cid: "bafkreibq4fevl27rgurgnxbp7adh42aqiyd6ouflxhj3gzmcxcxzbh6lla" },
];

/** Other CID shapes, also produced with multiformats 14.0.8. */
const CIDV0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CIDV0_AS_V1 = "bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34";
const CIDV0_DIGEST = "9d6c2be50f706953479ab9df2ce3edca90b68053c00b3004b7f0accbe1e8eedf";
const DAG_PB_V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const DAG_PB_V1_DIGEST = "c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31de94391a";
const RAW_SHA512 = "bafkrgqe3ohjcjplc6n4f3fwunlj6upltggn7xqujbsvnvyw764srszz4u4rshq6ztos4chl4plgg4ffyyxnayrtdi5oc4xb2332g645433aeg";
const DAG_JSON = "baguqeeraiqjw7i2vwntyuekgvulpp2det2kpwt6cd7tx5ayqybqpmhfk76fa";

describe("computeRawCid", () => {
  for (const vector of RAW_CID_VECTORS) {
    test(`matches the reference implementation for ${vector.label}`, () => {
      assert.equal(computeRawCid(vector.bytes), vector.cid);
    });
  }

  test("accepts Buffer and ArrayBuffer as well as Uint8Array", () => {
    const expected = RAW_CID_VECTORS[1].cid;
    assert.equal(computeRawCid(Buffer.from("hello world\n")), expected);
    assert.equal(computeRawCid(utf8("hello world\n").buffer), expected);
  });

  test("refuses a string, whose bytes would depend on an encoding choice", () => {
    assert.throws(() => computeRawCid("hello world\n"), InvalidContentError);
    assert.throws(() => toBytes(null), InvalidContentError);
  });

  test("changes completely when one bit of the input changes", () => {
    const original = utf8("lot 1 is fine");
    const tampered = Uint8Array.from(original);
    tampered[0] ^= 1;
    assert.notEqual(computeRawCid(original), computeRawCid(tampered));
  });
});

describe("parseCid", () => {
  test("decodes a raw + sha2-256 CIDv1", () => {
    const parsed = parseCid(RAW_CID_VECTORS[1].cid);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.codec, CODEC_RAW);
    assert.equal(parsed.codecName, "raw");
    assert.equal(parsed.hashCode, HASH_SHA2_256);
    assert.equal(parsed.hashName, "sha2-256");
    assert.equal(parsed.isRawSha256, true);
    assert.equal(parsed.text, RAW_CID_VECTORS[1].cid);
    assert.equal(parsed.v1, RAW_CID_VECTORS[1].cid);
    assert.equal(hex(parsed.digest), hex(sha256Digest(utf8("hello world\n"))));
  });

  test("decodes a dag-pb CIDv1, which is well formed but not a plain file hash", () => {
    const parsed = parseCid(DAG_PB_V1);
    assert.equal(parsed.codec, CODEC_DAG_PB);
    assert.equal(parsed.codecName, "dag-pb");
    assert.equal(parsed.isRawSha256, false);
    assert.equal(hex(parsed.digest), DAG_PB_V1_DIGEST);
  });

  test("decodes a CIDv0 and gives its CIDv1 form", () => {
    const parsed = parseCid(CIDV0);
    assert.equal(parsed.version, 0);
    assert.equal(parsed.codec, CODEC_DAG_PB);
    assert.equal(parsed.text, CIDV0);
    assert.equal(parsed.v1, CIDV0_AS_V1);
    assert.equal(hex(parsed.digest), CIDV0_DIGEST);
    assert.equal(parsed.isRawSha256, false);
  });

  test("accepts other hash functions and multi-byte codec numbers", () => {
    const sha512 = parseCid(RAW_SHA512);
    assert.equal(sha512.hashName, "sha2-512");
    assert.equal(sha512.digest.length, 64);
    assert.equal(sha512.isRawSha256, false, "raw codec but not sha2-256: no digest check is offered");

    const dagJson = parseCid(DAG_JSON);
    assert.equal(dagJson.codec, 0x0129, "0x0129 needs a two-byte varint");
    assert.equal(dagJson.codecName, "dag-json");
  });

  const good = RAW_CID_VECTORS[1].cid;
  const malformed = {
    "an empty string": "",
    "a non-string": 42,
    "upper case": good.toUpperCase(),
    "one upper-case letter": `${good.slice(0, 10)}${good[10].toUpperCase()}${good.slice(11)}`,
    "a character outside base32 (digit 1)": `${good.slice(0, -1)}1`,
    "base32 padding": `${good}=`,
    "a truncated CID": good.slice(0, 30),
    "an extra character (digest longer than announced)": `${good}a`,
    "non-canonical trailing bits": `${good.slice(0, -1)}5`,
    "an unsupported multibase (base58btc CIDv1)": "zb2rhe5P4gXftAwvA4eXQ5HJwsER2owDyS9sKaQRRVQPn93bA",
    "an unsupported multibase (base16)": "f01551220a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447",
    "a CIDv0 of the wrong length": CIDV0.slice(0, -1),
    "a CIDv0 containing the excluded base58 letter l": `${CIDV0.slice(0, 10)}l${CIDV0.slice(11)}`,
    "a path traversal": "../../etc/passwd",
    "a CID followed by a path": `${good}/secret`,
    "a CID with a leading space": ` ${good}`,
    "a CID with a trailing newline": `${good}\n`,
    "a CID with an embedded NUL": `${good.slice(0, 20)}\0${good.slice(21)}`,
    "more than the maximum length": `b${"a".repeat(MAX_CID_LENGTH)}`,
    "CID version 2": `b${base32Encode(Uint8Array.from([2, 0x55, 0x12, 0x20, ...new Uint8Array(32)]))}`,
    "a sha2-256 digest of the wrong length": `b${base32Encode(Uint8Array.from([1, 0x55, 0x12, 0x10, ...new Uint8Array(16)]))}`,
    "a header with no digest": `b${base32Encode(Uint8Array.from([1, 0x55]))}`,
    "a non-minimal varint": `b${base32Encode(Uint8Array.from([0x81, 0x00, 0x55, 0x12, 0x20, ...new Uint8Array(32)]))}`,
  };
  for (const [label, value] of Object.entries(malformed)) {
    test(`rejects ${label}`, () => {
      assert.throws(() => parseCid(value), InvalidCidError);
      assert.equal(isCid(value), false);
    });
  }

  test("error messages never repeat the rejected input", () => {
    const hostile = "../../etc/passwd<script>";
    assert.throws(
      () => parseCid(hostile),
      (error) => error instanceof InvalidCidError && !error.message.includes("passwd") && !error.message.includes("<script>"),
    );
  });

  test("isCid is true for every supported form", () => {
    for (const cid of [RAW_CID_VECTORS[0].cid, DAG_PB_V1, CIDV0, RAW_SHA512, DAG_JSON]) {
      assert.equal(isCid(cid), true, cid);
    }
  });
});

describe("computeContentHash", () => {
  test("is keccak256 of the bytes (known answers)", () => {
    // Published Keccak-256 test values: the empty input and the ASCII string "hello".
    assert.equal(computeContentHash(new Uint8Array(0)), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    assert.equal(computeContentHash(utf8("hello")), "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
  });

  test("is sensitive to a trailing newline, so documents must never be re-serialized", () => {
    assert.notEqual(computeContentHash(utf8('{"a":1}')), computeContentHash(utf8('{"a":1}\n')));
  });
});

describe("cidMatchesBytes", () => {
  test("answers true or false for raw + sha2-256 CIDs and null for the rest", () => {
    const bytes = utf8("hello world\n");
    assert.equal(cidMatchesBytes(RAW_CID_VECTORS[1].cid, bytes), true);
    assert.equal(cidMatchesBytes(RAW_CID_VECTORS[1].cid, utf8("hello world")), false);
    assert.equal(cidMatchesBytes(DAG_PB_V1, bytes), null);
    assert.equal(cidMatchesBytes(CIDV0, bytes), null);
    assert.equal(cidMatchesBytes(RAW_SHA512, utf8("hello")), null);
  });
});

describe("verifyContent", () => {
  const bytes = utf8("hello world\n");
  const ref = { cid: computeRawCid(bytes), contentHash: computeContentHash(bytes) };

  test("verifies matching bytes and reports both checks", () => {
    const report = verifyContent(bytes, ref);
    assert.equal(report.ok, true);
    assert.equal(report.size, 12);
    assert.deepEqual(report.contentHash, { expected: ref.contentHash, actual: ref.contentHash, valid: true, matches: true });
    assert.equal(report.cid.valid, true);
    assert.equal(report.cid.checked, true);
    assert.equal(report.cid.matches, true);
    assert.equal(report.cid.codec, "raw");
    assert.match(report.summary, /^verified: content hash and CID digest both match$/);
  });

  test("accepts the expected hash in upper-case hex", () => {
    const upper = `0x${ref.contentHash.slice(2).toUpperCase()}`;
    assert.equal(verifyContent(bytes, { ...ref, contentHash: upper }).ok, true);
  });

  test("detects a single flipped bit: both checks fail", () => {
    const tampered = Uint8Array.from(bytes);
    tampered[3] ^= 0x01;
    const report = verifyContent(tampered, ref);
    assert.equal(report.ok, false);
    assert.equal(report.contentHash.matches, false);
    assert.notEqual(report.contentHash.actual, ref.contentHash);
    assert.equal(report.cid.matches, false);
    assert.match(report.summary, /^NOT verified/);
  });

  test("detects appended and truncated bytes", () => {
    assert.equal(verifyContent(utf8("hello world\n "), ref).ok, false);
    assert.equal(verifyContent(bytes.subarray(0, 11), ref).ok, false);
  });

  test("fails when the bytes match the CID but not the on-chain hash", () => {
    const other = computeContentHash(utf8("something else"));
    const report = verifyContent(bytes, { cid: ref.cid, contentHash: other });
    assert.equal(report.ok, false);
    assert.equal(report.contentHash.matches, false);
    assert.equal(report.cid.matches, true, "the CID check is reported separately and still passes");
  });

  test("fails when the bytes match the on-chain hash but not the CID", () => {
    const report = verifyContent(bytes, { cid: RAW_CID_VECTORS[2].cid, contentHash: ref.contentHash });
    assert.equal(report.ok, false);
    assert.equal(report.contentHash.matches, true);
    assert.equal(report.cid.matches, false);
    assert.match(report.summary, /do not match the digest in the CID/);
  });

  test("for a dag-pb CID it relies on the content hash and says the CID check was skipped", () => {
    const report = verifyContent(bytes, { cid: DAG_PB_V1, contentHash: ref.contentHash });
    assert.equal(report.ok, true);
    assert.equal(report.cid.checked, false);
    assert.equal(report.cid.matches, null);
    assert.match(report.cid.detail, /not checked/);
    assert.match(report.summary, /CID digest not checkable/);

    const tampered = verifyContent(utf8("tampered"), { cid: DAG_PB_V1, contentHash: ref.contentHash });
    assert.equal(tampered.ok, false, "the content hash still catches the change");
  });

  test("reports a malformed reference instead of throwing", () => {
    const badCid = verifyContent(bytes, { cid: "not-a-cid", contentHash: ref.contentHash });
    assert.equal(badCid.ok, false);
    assert.equal(badCid.cid.valid, false);
    assert.equal(badCid.contentHash.matches, true);

    for (const contentHash of ["", "0x1234", ref.contentHash.slice(2), `${ref.contentHash}00`, undefined, 7]) {
      const report = verifyContent(bytes, { cid: ref.cid, contentHash });
      assert.equal(report.ok, false);
      assert.equal(report.contentHash.valid, false);
      assert.equal(report.contentHash.matches, false);
    }
    assert.equal(verifyContent(bytes, undefined).ok, false);
  });
});

describe("multibase primitives", () => {
  test("base32 round-trips every length from 0 to 40 bytes", () => {
    for (let length = 0; length <= 40; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
      assert.equal(hex(base32Decode(base32Encode(bytes))), hex(bytes), `length ${length}`);
    }
  });

  test("base32 matches the RFC 4648 test vectors (lower case, unpadded)", () => {
    const vectors = { "": "", f: "my", fo: "mzxq", foo: "mzxw6", foob: "mzxw6yq", fooba: "mzxw6ytb", foobar: "mzxw6ytboi" };
    for (const [plain, encoded] of Object.entries(vectors)) {
      assert.equal(base32Encode(utf8(plain)), encoded);
      assert.equal(new TextDecoder().decode(base32Decode(encoded)), plain);
    }
  });

  test("base32 decoding rejects impossible lengths, foreign characters and stray bits", () => {
    assert.throws(() => base32Decode("a"), RangeError);
    assert.throws(() => base32Decode("mzx"), RangeError);
    assert.throws(() => base32Decode("MY"), RangeError);
    assert.throws(() => base32Decode("m1"), RangeError);
    assert.throws(() => base32Decode("mz"), RangeError, '"my" is canonical for "f"; "mz" sets unused bits');
  });

  test("base58 decoding keeps leading zero bytes and rejects foreign characters", () => {
    assert.equal(hex(base58Decode("11")), "0000");
    assert.equal(hex(base58Decode("2g")), "61");
    assert.equal(hex(base58Decode("StV1DL6CwTryKyV")), hex(utf8("hello world")));
    assert.throws(() => base58Decode("0OIl"), RangeError);
  });

  test("varints round-trip and reject over-long or non-minimal encodings", () => {
    for (const value of [0, 1, 0x55, 0x7f, 0x80, 0x0129, 0xb220, 0x3fff, 0x4000, 268435455]) {
      const encoded = Uint8Array.from(varintEncode(value));
      assert.deepEqual(varintDecode(encoded, 0), { value, next: encoded.length });
    }
    assert.throws(() => varintDecode(Uint8Array.from([0x80]), 0), RangeError, "cut short");
    assert.throws(() => varintDecode(Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x01]), 0), RangeError, "too long");
    assert.throws(() => varintDecode(Uint8Array.from([0x80, 0x00]), 0), RangeError, "non-minimal");
    assert.throws(() => varintEncode(-1), RangeError);
  });
});
