// Tooling test: the committed ABI must match the compiled contract.
//
// Run: npm run test:tooling   (also part of `npm test`)
//
// deployments/abi/ProvenanceRegistry.json is what frontend/ and oracle/ load
// on a fresh clone. If a contract change were merged without re-exporting
// that file, both would keep encoding calls and decoding events and errors
// against the old interface. This test turns that mistake into a failing
// check, with a message that names what differs and how to fix it.
//
// The comparison is against the artifact on disk. `hardhat test` compiles
// before it runs the tests, so the artifact is current unless the run was
// started with --no-compile on stale artifacts.
import { expect } from "chai";
import { Interface } from "ethers";
import { readFile } from "node:fs/promises";
import { ABI_PATH, fromRoot, readCompiledAbi } from "../../scripts/lib/abi.js";

const HOW_TO_FIX = `Run \`npm run compile\` (hardhat compile + ABI export) and commit ${ABI_PATH}.`;

async function readCommittedAbi() {
  let text;
  try {
    text = await readFile(fromRoot(ABI_PATH), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`${ABI_PATH} is missing. ${HOW_TO_FIX}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${ABI_PATH} is not valid JSON (${error.message}). ${HOW_TO_FIX}`);
  }
}

// One readable line per ABI entry, for example
// "error BatchNotFound(uint256 batchId)". Used to say which entries differ.
function signatures(abi) {
  return new Interface(abi).format();
}

describe("tooling: committed ABI (deployments/abi)", function () {
  it("is a non-empty JSON array", async function () {
    const committed = await readCommittedAbi();
    expect(committed, `${ABI_PATH} must hold the ABI array itself`).to.be.an("array").that.is.not.empty;
  });

  it("declares the same functions, events and errors as the compiled contract", async function () {
    const compiled = signatures(await readCompiledAbi());
    const committed = signatures(await readCommittedAbi());

    const notExported = compiled.filter((signature) => !committed.includes(signature));
    const noLongerInContract = committed.filter((signature) => !compiled.includes(signature));
    if (notExported.length > 0 || noLongerInContract.length > 0) {
      const lines = [`${ABI_PATH} is out of date with the compiled contract.`];
      if (notExported.length > 0) {
        lines.push("In the contract but not in the committed file:", ...notExported.map((s) => `  + ${s}`));
      }
      if (noLongerInContract.length > 0) {
        lines.push("In the committed file but not in the contract:", ...noLongerInContract.map((s) => `  - ${s}`));
      }
      lines.push(HOW_TO_FIX);
      expect.fail(lines.join("\n"));
    }
  });

  it("is identical to what the export writes, entry for entry and in the compiler's order", async function () {
    // Stricter than the signature check above: it also covers the entry
    // order and fields such as internalType, so that re-running the export
    // on an unchanged contract never produces a diff.
    expect(
      await readCommittedAbi(),
      `${ABI_PATH} is not what the export writes for the compiled contract ` +
        `(entries, their order or their fields differ). ${HOW_TO_FIX}`,
    ).to.deep.equal(await readCompiledAbi());
  });
});
