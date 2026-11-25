// Content identifiers for the off-chain documents that the scripts reference.
//
// On-chain, every document is a DocumentRef { string cid; bytes32 contentHash }
// (design decision O1): the CID locates the file on IPFS, and keccak256 of the
// exact file bytes lets a reader check that the file was not edited.
//
// The scripts in this folder do not talk to an IPFS node, but the CIDs they
// write on-chain are real ones, computed from the document bytes. That keeps a
// demo lot's record well formed: pinning the same bytes later with
// `ipfs add --cid-version=1` yields the CID that is already on-chain.
//
// CID format produced here (the "bafkrei..." form):
//
//   CIDv1 bytes = 0x01        CID version 1
//                 0x55        multicodec "raw": the block is the file itself
//                 0x12        multihash function sha2-256
//                 0x20        digest length, 32 bytes
//                 <32 bytes>  sha2-256 of the file bytes
//
//   CID string  = "b" + base32(CIDv1 bytes)
//                 "b" is the multibase prefix for RFC 4648 base32, lower case,
//                 without padding. 36 bytes become 58 characters, so every CID
//                 from this helper is 59 characters long.
//
// IPFS produces exactly this CID for a file that fits in one chunk (256 KiB
// by default) when raw leaves are on, which CIDv1 implies. A larger file is
// split into a DAG and gets a different ("bafybei...") CID. The documents in
// this project (lot metadata, certificates, sensor logs) are small JSON files.
//
// Only Node built-ins and ethers are used, so the helper adds no dependency.
import { createHash } from "node:crypto";
import { keccak256 } from "ethers";

const CID_VERSION_1 = 0x01;
const MULTICODEC_RAW = 0x55;
const MULTIHASH_SHA2_256 = 0x12;
const SHA2_256_LENGTH = 0x20;

// RFC 4648 base32 alphabet in lower case, as the "b" multibase prefix requires.
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

// Base32 without padding: read the input as one bit string and emit a
// character for every 5 bits. A final group of fewer than 5 bits is padded
// with zero bits on the right, as RFC 4648 specifies.
function base32Encode(bytes) {
  let output = "";
  let buffer = 0; // bits read from the input but not yet emitted
  let bitCount = 0; // how many bits `buffer` holds; always below 5 between bytes
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      output += BASE32_ALPHABET[(buffer >>> bitCount) & 31];
    }
    // Drop the bits that were emitted, so `buffer` never outgrows 32 bits.
    buffer &= (1 << bitCount) - 1;
  }
  if (bitCount > 0) output += BASE32_ALPHABET[(buffer << (5 - bitCount)) & 31];
  return output;
}

// Text must be encoded by the caller. Hashing a string here would make the
// result depend on a hidden encoding choice, and the on-chain hash has to
// match the uploaded bytes exactly.
function requireBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Expected the document as a Uint8Array or Buffer (encode text as UTF-8 first).");
  }
}

/**
 * CID of a file stored as a single raw block: CIDv1, raw codec, sha2-256,
 * base32 ("bafkrei...").
 * @param {Uint8Array} bytes the exact file bytes
 * @returns {string} the 59-character CID string
 */
export function rawCidV1(bytes) {
  requireBytes(bytes);
  const digest = createHash("sha256").update(bytes).digest();
  const cidBytes = Uint8Array.of(CID_VERSION_1, MULTICODEC_RAW, MULTIHASH_SHA2_256, SHA2_256_LENGTH, ...digest);
  return "b" + base32Encode(cidBytes);
}

/**
 * Build the DocumentRef that the registry stores for a file.
 * @param {Uint8Array} bytes the exact file bytes
 * @returns {{ cid: string, contentHash: string }} the CID, and keccak256 of the
 *          bytes as 0x-prefixed hex
 */
export function documentRef(bytes) {
  return { cid: rawCidV1(bytes), contentHash: keccak256(bytes) };
}
