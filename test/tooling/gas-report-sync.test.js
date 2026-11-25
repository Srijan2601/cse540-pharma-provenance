// Tooling test: the committed gas report must describe the current code.
//
// Run: npm run test:tooling   (also part of `npm test`)
//
// docs/analysis/data/gas-report.{json,md} feed the cost analysis. If the
// contract changed and nobody re-ran `npm run gas:report`, the committed
// numbers would silently describe old bytecode. The report is stamped with a
// fingerprint of the code it measured (scripts/lib/gas-report-stamp.js);
// this test compares that stamp with the compiled artifact, the way
// abi-sync.test.js does for the ABI.
//
// The fingerprint leaves out the compiler's metadata hash, so editing only
// comments does not ask for a new report (see gas-report-stamp.js for why
// that is safe).
import { expect } from "chai";
import { globalOptions } from "hardhat";
import { readFile } from "node:fs/promises";
import { fromRoot, readCompiledArtifact } from "../../scripts/lib/abi.js";
import {
  GAS_REPORT_JSON_PATH,
  GAS_REPORT_MARKDOWN_PATH,
  codeFingerprint,
} from "../../scripts/lib/gas-report-stamp.js";

const HOW_TO_FIX = `Run \`npm run gas:report\` and commit ${GAS_REPORT_JSON_PATH} and ${GAS_REPORT_MARKDOWN_PATH}.`;

async function readCommitted(path) {
  try {
    return await readFile(fromRoot(path), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`${path} is missing. ${HOW_TO_FIX}`);
  }
}

describe("tooling: committed gas report (docs/analysis/data)", function () {
  before(function () {
    // `hardhat test --coverage` compiles instrumented contracts into the same
    // artifacts folder, so during a coverage run the artifact is not the code
    // the report measures. The check is meaningful only on a normal build.
    if (globalOptions.coverage) this.skip();
  });

  it("was measured on the code the contracts compile to now", async function () {
    const report = JSON.parse(await readCommitted(GAS_REPORT_JSON_PATH));
    const current = codeFingerprint(await readCompiledArtifact());
    expect(
      report.codeFingerprint,
      `${GAS_REPORT_JSON_PATH} was measured on other code than the contracts compile to now. ${HOW_TO_FIX}`,
    ).to.equal(current);
  });

  it("has a Markdown version from the same run as the JSON", async function () {
    // The two files are written together; a commit that updates only one of
    // them would leave the tables and the data disagreeing.
    const { codeFingerprint: stamped } = JSON.parse(await readCommitted(GAS_REPORT_JSON_PATH));
    const markdown = await readCommitted(GAS_REPORT_MARKDOWN_PATH);
    expect(markdown, `${GAS_REPORT_MARKDOWN_PATH} does not match the JSON report. ${HOW_TO_FIX}`).to.include(stamped);
  });
});
