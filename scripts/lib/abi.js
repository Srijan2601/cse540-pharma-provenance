// Where the registry's ABI lives, and how it is written to the committed file.
//
// Shared by scripts/export-abi.js, which writes the file, and
// test/tooling/abi-sync.test.js, which checks it, so that both agree on the
// paths and on the exact file format. The artifact reader is also used by
// test/tooling/gas-report-sync.test.js.
//
// This module does not import Hardhat. It reads the artifact that
// `hardhat compile` leaves on disk, from Hardhat's default artifacts folder
// (hardhat.config.js does not override paths.artifacts).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const CONTRACT_NAME = "ProvenanceRegistry";

// Paths relative to the repository root, for messages.
export const ARTIFACT_PATH = `artifacts/contracts/${CONTRACT_NAME}.sol/${CONTRACT_NAME}.json`;
export const ABI_PATH = `deployments/abi/${CONTRACT_NAME}.json`;

const repositoryRoot = new URL("../../", import.meta.url);

/** Absolute file-system path of a path given relative to the repository root. */
export function fromRoot(relativePath) {
  return fileURLToPath(new URL(relativePath, repositoryRoot));
}

/**
 * Read the compiled artifact of the registry (ABI, bytecode, ...).
 * @returns {Promise<object>} the parsed artifact JSON
 */
export async function readCompiledArtifact() {
  let text;
  try {
    text = await readFile(fromRoot(ARTIFACT_PATH), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`${ARTIFACT_PATH} does not exist. Compile the contracts first: npx hardhat compile`);
  }
  return JSON.parse(text);
}

/**
 * Read the ABI from the compiled artifact.
 * @returns {Promise<object[]>} the ABI array, in the order solc emitted it
 */
export async function readCompiledAbi() {
  const { abi } = await readCompiledArtifact();
  if (!Array.isArray(abi)) throw new Error(`${ARTIFACT_PATH} has no "abi" array.`);
  return abi;
}

/**
 * The text of the committed ABI file: the ABI array, pretty-printed.
 *
 * The entries stay in the compiler's order. solc sorts them by kind
 * (constructor, errors, events, functions) and then by name, so the order
 * does not depend on the order of declarations in the Solidity files, and a
 * change to the interface shows up as a small diff.
 */
export function formatAbi(abi) {
  return JSON.stringify(abi, null, 2) + "\n";
}
