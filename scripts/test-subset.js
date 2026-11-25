// Run the mocha tests of one folder under test/.
//
// Usage:
//   npm run test:unit                        test/unit
//   npm run test:integration                 test/integration
//   npm run test:tooling                     test/tooling
//   npm run test:unit -- --grep "recall"     extra options go to `hardhat test mocha`
//   node scripts/test-subset.js <folder> [hardhat options]
//
// Why this script exists: `hardhat test mocha` takes a list of test FILES. It
// does not expand a folder or a glob pattern. A pattern such as
// test/unit/*.test.js in package.json would be expanded by the shell, which
// works in sh but not in Windows cmd.exe (npm's default script shell there),
// and it would miss tests in sub-folders. This script lists the files itself
// and hands them to the same Hardhat command, so the subsets behave the same
// on every platform.
//
// A subset contains every JavaScript file below its folder: the rule Hardhat
// applies to test/ as a whole. So `npm run test:unit` runs exactly the part
// of `npm test` that lives in test/unit.
//
// The Solidity tests need no such script: `npm run test:solidity` is
// `hardhat test solidity`, which finds them by itself.
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [folder, ...hardhatOptions] = process.argv.slice(2);
if (!folder || folder.startsWith("-")) {
  console.error("Usage: node scripts/test-subset.js <folder under test/> [hardhat options]");
  process.exit(1);
}

const rootUrl = new URL("../", import.meta.url);
const root = fileURLToPath(rootUrl);
const directory = path.join("test", folder);

let entries;
try {
  entries = await readdir(path.join(root, directory), { recursive: true });
} catch (error) {
  if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  console.error(`There is no folder ${directory}/.`);
  process.exit(1);
}
// Sorted, so the tests run in the same order on every file system.
const files = entries
  .filter((entry) => /\.(js|cjs|mjs)$/.test(entry))
  .sort()
  .map((entry) => path.join(directory, entry));
if (files.length === 0) {
  console.error(`No test files (*.js) found in ${directory}/.`);
  process.exit(1);
}

// Start Hardhat's command-line entry point with the Node binary that runs
// this script. That avoids the platform-specific `npx` / `hardhat.cmd` shims.
const hardhatPackage = new URL("node_modules/hardhat/package.json", rootUrl);
const { bin } = JSON.parse(await readFile(hardhatPackage, "utf8"));
const hardhatCli = fileURLToPath(new URL(bin.hardhat, hardhatPackage));

const child = spawn(process.execPath, [hardhatCli, "test", "mocha", ...hardhatOptions, ...files], {
  cwd: root,
  stdio: "inherit",
});
// Pass Hardhat's result on unchanged, so a failing test fails `npm run` too.
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
