/**
 * CIDs and content hashes: the two halves of an on-chain DocumentRef.
 *
 *   struct DocumentRef { string cid; bytes32 contentHash; }
 *
 *   cid          locates the file on IPFS.
 *   contentHash  keccak256 of the exact uploaded bytes; it is what the verify
 *                page recomputes, because a CID is in general NOT a plain hash
 *                of the file (design decision O1).
 *
 * CID format produced by this package (the local backend): CIDv1, codec "raw"
 * (0x55), multihash sha2-256, written in lower-case base32 with the "b"
 * multibase prefix, which gives "bafkrei..." strings. The file is one raw
 * block, so the digest inside the CID is simply sha2-256(file bytes). That is
 * exactly what `ipfs add --cid-version=1` returns for a file that fits in one
 * chunk (256 KiB by default), so small files get the same CID here and on
 * public IPFS. Larger files are split into a DAG by real IPFS nodes and get a
 * different ("bafybei...", dag-pb) CID there.
 *
 * CID strings accepted from elsewhere (a pinning service, the chain, a URL):
 * any CIDv1 in base32 lower case, and legacy CIDv0 ("Qm..."). Only raw +
 * sha2-256 CIDs can be re-checked against file bytes; for the others the
 * keccak256 content hash is the integrity check.
 *
 * No Node-only imports: this file also runs in the browser (ethers provides
 * sha256 and keccak256 in both environments).
 */

import { getBytes, hexlify, keccak256, sha256 } from "ethers";

import { InvalidCidError, InvalidContentError } from "../errors.js";
import { base32Decode, base32Encode, base58Decode, varintDecode, varintEncode } from "./multibase.js";

/** Multicodec code of the "raw" codec: the block is the file itself. */
export const CODEC_RAW = 0x55;
/** Multicodec code of "dag-pb", the codec of UnixFS file and directory nodes (and of every CIDv0). */
export const CODEC_DAG_PB = 0x70;
/** Multihash code of sha2-256. */
export const HASH_SHA2_256 = 0x12;
/** Length of a sha2-256 digest in bytes. */
export const SHA2_256_BYTES = 32;

/**
 * Default IPFS chunk size. A file of at most this many bytes is stored as one
 * raw block by `ipfs add --cid-version=1`, so its public CID equals
 * computeRawCid(bytes).
 */
export const IPFS_SINGLE_CHUNK_BYTES = 262144;

/**
 * Largest file the local backend stores as a single raw block (1 MiB). IPFS
 * nodes exchange blocks of at most about this size, so a larger single block
 * could not be served by the public network and its CID would be useless
 * outside this machine.
 */
export const MAX_RAW_BLOCK_BYTES = 1048576;

/**
 * Longest CID string accepted. A sha2-256 CIDv1 is 59 characters and a
 * sha2-512 one is 110; the cap bounds the work done on untrusted input.
 */
export const MAX_CID_LENGTH = 128;

/** Names for the codecs and hash functions likely to appear, used only in messages and reports. */
const CODEC_NAMES = new Map([
  [CODEC_RAW, "raw"],
  [CODEC_DAG_PB, "dag-pb"],
  [0x71, "dag-cbor"],
  [0x0129, "dag-json"],
  [0x0200, "json"],
]);
const HASH_NAMES = new Map([
  [0x00, "identity"],
  [HASH_SHA2_256, "sha2-256"],
  [0x13, "sha2-512"],
  [0x1e, "blake3"],
  [0xb220, "blake2b-256"],
]);

const CIDV0_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CONTENT_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * @typedef {object} ParsedCid
 * @property {string} text         the CID string as given (already canonical, see parseCid)
 * @property {string} v1           the same CID as a base32 CIDv1 string; equal to `text` unless `text` is a CIDv0
 * @property {0|1} version
 * @property {number} codec        multicodec code, for example 0x55
 * @property {string} codecName    "raw", "dag-pb", ... or the code in hex when it has no name here
 * @property {number} hashCode     multihash code, for example 0x12
 * @property {string} hashName     "sha2-256", ... or the code in hex
 * @property {Uint8Array} digest   the hash digest inside the CID
 * @property {boolean} isRawSha256 true when the CID is codec raw + sha2-256, i.e. digest = sha2-256(file bytes)
 */

/**
 * Normalize a caller-supplied byte container to a Uint8Array.
 * @param {Uint8Array|ArrayBuffer} value a Uint8Array (including Node's Buffer) or an ArrayBuffer
 * @returns {Uint8Array}
 * @throws {InvalidContentError} for anything else, for example a string: hashing text would
 *         silently depend on an encoding choice, so callers must encode it themselves
 */
export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new InvalidContentError("Content must be a Uint8Array, Buffer or ArrayBuffer (encode text with TextEncoder first).");
}

/**
 * sha2-256 of some bytes.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Uint8Array} the 32-byte digest
 */
export function sha256Digest(bytes) {
  return getBytes(sha256(toBytes(bytes)));
}

/**
 * The content hash stored on-chain next to a CID: keccak256 of the exact bytes.
 * @param {Uint8Array|ArrayBuffer} bytes the bytes exactly as uploaded
 * @returns {string} "0x" + 64 lower-case hex characters
 */
export function computeContentHash(bytes) {
  return keccak256(toBytes(bytes));
}

/**
 * Compute the CID of a file stored as ONE raw block: CIDv1, raw codec,
 * sha2-256, base32 lower case ("bafkrei...").
 *
 * Binary layout before base32: 0x01 (version) 0x55 (raw) 0x12 (sha2-256)
 * 0x20 (digest length 32) followed by the 32 digest bytes.
 *
 * @param {Uint8Array|ArrayBuffer} bytes the file bytes
 * @returns {string} the CID string
 */
export function computeRawCid(bytes) {
  return encodeCidV1(CODEC_RAW, HASH_SHA2_256, sha256Digest(bytes));
}

/**
 * Parse and validate a CID string.
 *
 * Accepted: CIDv1 in lower-case base32 ("b" + a-z2-7, no padding) with any
 * codec and hash function, and CIDv0 ("Qm" + 44 base58 characters, which is
 * always dag-pb + sha2-256). Rejected with InvalidCidError: other multibase
 * encodings, upper case, padding, non-canonical encodings, a digest whose
 * length does not match its header, trailing bytes, and strings longer than
 * MAX_CID_LENGTH.
 *
 * Because only canonical strings pass, a parsed CID contains nothing but
 * characters from [a-z2-7] (v1) or the base58 alphabet (v0). Code that maps a
 * CID to a file name must still use `v1`, never the input string.
 *
 * @param {string} text
 * @returns {ParsedCid}
 * @throws {InvalidCidError}
 */
export function parseCid(text) {
  if (typeof text !== "string") {
    throw new InvalidCidError("A CID must be a string.");
  }
  if (text.length === 0) {
    throw new InvalidCidError("The CID is empty.");
  }
  if (text.length > MAX_CID_LENGTH) {
    throw new InvalidCidError(`The CID is longer than ${MAX_CID_LENGTH} characters.`);
  }

  if (CIDV0_PATTERN.test(text)) {
    return parseCidV0(text);
  }
  if (text[0] !== "b") {
    throw new InvalidCidError(
      'Unsupported CID encoding: expected a base32 CIDv1 (starts with "b", lower case) or a CIDv0 (starts with "Qm").',
    );
  }

  let bytes;
  try {
    bytes = base32Decode(text.slice(1));
  } catch (error) {
    throw new InvalidCidError(`Malformed CID: ${error.message}.`);
  }

  let version, codec, hashCode, digestLength;
  try {
    version = varintDecode(bytes, 0);
    codec = varintDecode(bytes, version.next);
    hashCode = varintDecode(bytes, codec.next);
    digestLength = varintDecode(bytes, hashCode.next);
  } catch (error) {
    throw new InvalidCidError(`Malformed CID: ${error.message}.`);
  }
  if (version.value !== 1) {
    throw new InvalidCidError(`Unsupported CID version ${version.value}: only CIDv1 and CIDv0 exist.`);
  }
  const digest = bytes.subarray(digestLength.next);
  if (digest.length !== digestLength.value) {
    throw new InvalidCidError(
      `Malformed CID: the multihash header announces a ${digestLength.value}-byte digest but ${digest.length} bytes follow.`,
    );
  }
  if (hashCode.value === HASH_SHA2_256 && digest.length !== SHA2_256_BYTES) {
    throw new InvalidCidError("Malformed CID: a sha2-256 digest must be 32 bytes long.");
  }
  return describeCid(text, text, 1, codec.value, hashCode.value, digest);
}

/**
 * Tell whether a string is a CID that parseCid accepts, without throwing.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isCid(text) {
  try {
    parseCid(/** @type {string} */ (text));
    return true;
  } catch (error) {
    if (error instanceof InvalidCidError) return false;
    throw error;
  }
}

/**
 * Check file bytes against the digest inside a CID.
 *
 * Only possible for raw + sha2-256 CIDs, where the digest is the hash of the
 * file itself. For a dag-pb CID the digest covers a DAG node, not the file,
 * so the answer is "cannot tell" (null) and the keccak256 content hash must be
 * used instead.
 *
 * @param {string|ParsedCid} cid
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {boolean|null} true = matches, false = does not match, null = this kind of CID cannot be checked this way
 * @throws {InvalidCidError} when `cid` is a malformed string
 */
export function cidMatchesBytes(cid, bytes) {
  const parsed = typeof cid === "string" ? parseCid(cid) : cid;
  if (!parsed.isRawSha256) return null;
  return equalBytes(parsed.digest, sha256Digest(bytes));
}

/**
 * @typedef {object} VerificationReport
 * @property {boolean} ok        true only if the content hash matches, the CID is well formed, and the
 *                               CID digest check either passed or was not possible for this kind of CID
 * @property {number} size       number of bytes that were checked
 * @property {{ expected: string, actual: string, matches: boolean, valid: boolean }} contentHash
 *                               keccak256 check; `valid` is false when `expected` is not a bytes32 hex string
 * @property {{ value: string, valid: boolean, checked: boolean, matches: boolean|null, codec: string|null, hash: string|null, detail: string }} cid
 *                               CID check; `checked` is true only for raw + sha2-256 CIDs
 * @property {string} summary    one line for a person
 */

/**
 * Verify fetched bytes against a DocumentRef and say precisely what matched.
 *
 * Two independent checks:
 *   1. contentHash: keccak256(bytes) must equal the on-chain hash. This is the
 *      authoritative check and always runs.
 *   2. CID digest: when the CID is raw + sha2-256, sha2-256(bytes) must equal
 *      the digest in the CID, which proves the gateway returned the content
 *      the CID names. For other CIDs the report says the check was skipped.
 *
 * It never throws for a mismatch or a malformed reference: bad input is part
 * of what a verifier has to report.
 *
 * @param {Uint8Array|ArrayBuffer} bytes the bytes exactly as fetched
 * @param {{ cid: string, contentHash: string }} ref the on-chain DocumentRef
 * @returns {VerificationReport}
 */
export function verifyContent(bytes, ref) {
  const content = toBytes(bytes);
  const expectedHash = typeof ref?.contentHash === "string" ? ref.contentHash : "";
  const hashValid = CONTENT_HASH_PATTERN.test(expectedHash);
  const actualHash = computeContentHash(content);
  const contentHash = {
    expected: expectedHash,
    actual: actualHash,
    valid: hashValid,
    matches: hashValid && expectedHash.toLowerCase() === actualHash,
  };

  const cidText = typeof ref?.cid === "string" ? ref.cid : "";
  const cid = { value: cidText, valid: false, checked: false, matches: null, codec: null, hash: null, detail: "" };
  try {
    const parsed = parseCid(cidText);
    cid.valid = true;
    cid.codec = parsed.codecName;
    cid.hash = parsed.hashName;
    if (parsed.isRawSha256) {
      cid.checked = true;
      cid.matches = equalBytes(parsed.digest, sha256Digest(content));
      cid.detail = cid.matches
        ? "sha2-256 of the bytes equals the digest in the CID"
        : "sha2-256 of the bytes differs from the digest in the CID";
    } else {
      cid.detail = `not checked: a ${parsed.codecName} / ${parsed.hashName} CID does not contain a plain hash of the file`;
    }
  } catch (error) {
    if (!(error instanceof InvalidCidError)) throw error;
    cid.detail = error.message;
  }

  const ok = contentHash.matches && cid.valid && cid.matches !== false;
  let summary;
  if (ok) {
    summary = cid.checked
      ? "verified: content hash and CID digest both match"
      : "verified: content hash matches (CID digest not checkable for this CID type)";
  } else if (!contentHash.valid) {
    summary = "NOT verified: the expected content hash is not a 32-byte hex string";
  } else if (!contentHash.matches) {
    summary = "NOT verified: the bytes do not hash to the expected content hash";
  } else if (!cid.valid) {
    summary = "NOT verified: the CID is malformed";
  } else {
    summary = "NOT verified: the bytes do not match the digest in the CID";
  }
  return { ok, size: content.length, contentHash, cid, summary };
}

/**
 * Parse a CIDv0: base58btc of a bare sha2-256 multihash (0x12 0x20 + 32 bytes), implicitly dag-pb.
 * @param {string} text already matched against CIDV0_PATTERN
 * @returns {ParsedCid}
 */
function parseCidV0(text) {
  const multihash = base58Decode(text);
  if (multihash.length !== 2 + SHA2_256_BYTES || multihash[0] !== HASH_SHA2_256 || multihash[1] !== SHA2_256_BYTES) {
    throw new InvalidCidError("Malformed CIDv0: it does not decode to a sha2-256 multihash.");
  }
  const digest = multihash.subarray(2);
  return describeCid(text, encodeCidV1(CODEC_DAG_PB, HASH_SHA2_256, digest), 0, CODEC_DAG_PB, HASH_SHA2_256, digest);
}

/**
 * Build the ParsedCid record.
 * @param {string} text     the CID string as given
 * @param {string} v1       its base32 CIDv1 form
 * @param {0|1} version
 * @param {number} codec    multicodec code
 * @param {number} hashCode multihash code
 * @param {Uint8Array} digest
 * @returns {ParsedCid}
 */
function describeCid(text, v1, version, codec, hashCode, digest) {
  return Object.freeze({
    text,
    v1,
    version,
    codec,
    codecName: CODEC_NAMES.get(codec) ?? `0x${codec.toString(16)}`,
    hashCode,
    hashName: HASH_NAMES.get(hashCode) ?? `0x${hashCode.toString(16)}`,
    digest: Uint8Array.from(digest),
    isRawSha256: version === 1 && codec === CODEC_RAW && hashCode === HASH_SHA2_256,
  });
}

/**
 * Encode a CIDv1 as a base32 string.
 * @param {number} codec
 * @param {number} hashCode
 * @param {Uint8Array} digest
 * @returns {string}
 */
function encodeCidV1(codec, hashCode, digest) {
  const header = [...varintEncode(1), ...varintEncode(codec), ...varintEncode(hashCode), ...varintEncode(digest.length)];
  const bytes = new Uint8Array(header.length + digest.length);
  bytes.set(header, 0);
  bytes.set(digest, header.length);
  return `b${base32Encode(bytes)}`;
}

/**
 * Compare two digests.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function equalBytes(a, b) {
  // Digests are public values, so a plain comparison is fine (nothing secret can leak through timing).
  return a.length === b.length && hexlify(a) === hexlify(b);
}
