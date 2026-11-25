// Tooling test: the CID helper used by the demo and gas-report scripts.
//
// Run: npm run test:tooling   (also part of `npm test`)
//
// scripts/lib/cid.js computes CIDs by hand (CIDv1, raw codec, sha2-256,
// base32) instead of asking an IPFS node. The expected values below are the
// CIDs that IPFS itself gives for the same bytes with
// `ipfs add --cid-version=1`, so the tests pin the helper to the real
// encoding. A wrong CID would not make any contract call fail (the contract
// cannot check a CID), which is why it needs a test of its own.
import { expect } from "chai";
import { keccak256, toUtf8Bytes } from "ethers";
import { documentRef, rawCidV1 } from "../../scripts/lib/cid.js";

describe("tooling: CID helper (scripts/lib/cid.js)", function () {
  it("gives the published CID of the empty file", function () {
    expect(rawCidV1(new Uint8Array(0))).to.equal("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
  });

  it("gives the published CID of the bytes 'hello world'", function () {
    expect(rawCidV1(toUtf8Bytes("hello world"))).to.equal(
      "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e",
    );
  });

  it("always returns 59 lower-case base32 characters starting with bafkrei", function () {
    // Lengths around the 5-byte base32 group size, and one larger document.
    for (const length of [0, 1, 2, 3, 4, 5, 6, 31, 32, 33, 1000]) {
      const cid = rawCidV1(new Uint8Array(length).fill(0xa7));
      expect(cid, `document of ${length} bytes`).to.match(/^bafkrei[a-z2-7]{52}$/);
    }
  });

  it("changes the CID when a single bit of the document changes", function () {
    const original = toUtf8Bytes('{"lotNumber":"LOT-1"}');
    const edited = Uint8Array.from(original);
    edited[edited.length - 1] ^= 0x01;
    expect(rawCidV1(edited)).to.not.equal(rawCidV1(original));
  });

  it("pairs the CID with keccak256 of the same bytes", function () {
    // The content hash must be the value the contract's readers recompute
    // with ethers.keccak256, not the sha2-256 digest that is inside the CID.
    const bytes = toUtf8Bytes("hello world");
    expect(documentRef(bytes)).to.deep.equal({ cid: rawCidV1(bytes), contentHash: keccak256(bytes) });
  });

  it("accepts a Node Buffer and rejects text that was not encoded to bytes", function () {
    expect(rawCidV1(Buffer.from("hello world"))).to.equal(rawCidV1(toUtf8Bytes("hello world")));
    expect(() => rawCidV1("hello world")).to.throw(TypeError, /Uint8Array/);
    expect(() => documentRef("hello world")).to.throw(TypeError, /Uint8Array/);
  });
});
