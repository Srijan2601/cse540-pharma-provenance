// Which code the committed gas report measured, and where the report lives.
//
// Shared by scripts/gas-report.js, which stamps the report, and
// test/tooling/gas-report-sync.test.js, which checks the stamp against the
// current build, so that both agree on the paths and on the fingerprint.
//
// Why a fingerprint and not a git commit: the report is committed, and a file
// generated before a commit can never name the commit that contains it. A
// fingerprint of the compiled code is known before committing, stays true
// after it, and lets a test notice a report that was not regenerated after a
// contract change (as test/tooling/abi-sync.test.js does for the ABI).
//
// This module does not import Hardhat; the caller passes the artifact.
import { keccak256 } from "ethers";

/** The committed report files, relative to the repository root. */
export const GAS_REPORT_JSON_PATH = "docs/analysis/data/gas-report.json";
export const GAS_REPORT_MARKDOWN_PATH = "docs/analysis/data/gas-report.md";

/**
 * keccak256 of the contract's creation bytecode (constructor plus runtime
 * code) with the compiler's metadata hash removed.
 *
 * solc appends a CBOR block to the runtime code, followed by two bytes that
 * give the block's length. The block holds a hash of the metadata, which in
 * turn hashes every source file byte for byte, so it changes with a comment
 * edit or with line endings (Git for Windows checks files out with CRLF by
 * default). It is never executed, so no function's gas depends on it. Only
 * the deployment's calldata cost does, and only slightly: the 32 bytes of the
 * digest cost 4 gas each when zero and 16 when not, a difference of at most
 * 384 gas on a deployment of about two million. Leaving the block out keeps
 * the check stable across such edits and platforms, while any change to the
 * code itself, and so to any measured number beyond that margin, changes the
 * fingerprint.
 *
 * @param {{ bytecode: string, deployedBytecode: string }} artifact
 *        a Hardhat artifact (0x-prefixed hex strings)
 * @returns {string} 0x-prefixed keccak256 hash
 */
export function codeFingerprint({ bytecode, deployedBytecode }) {
  const runtime = deployedBytecode.slice(2).toLowerCase();
  const creation = bytecode.slice(2).toLowerCase();
  const cborBytes = parseInt(runtime.slice(-4), 16);
  const metadata = runtime.slice(-(cborBytes + 2) * 2);
  // The runtime code is embedded in the creation code, metadata included.
  // Finding it there also confirms the length was read correctly.
  if (!Number.isInteger(cborBytes) || cborBytes === 0 || !creation.includes(metadata)) {
    throw new Error("Could not locate the compiler metadata in the artifact's bytecode.");
  }
  return keccak256(`0x${creation.split(metadata).join("")}`);
}
