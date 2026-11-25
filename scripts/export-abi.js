// Export the ABI of ProvenanceRegistry to deployments/abi/ProvenanceRegistry.json.
//
// Usage:
//   npm run compile       hardhat compile, then this export
//   npm run abi:export    this export alone (the contracts must be compiled already)
//
// Why the file is committed: frontend/ and oracle/ need the ABI on a fresh
// clone, before any deployment exists. Hardhat's artifacts/ folder is
// gitignored, and deployments/<network>.json only appears after a deploy.
// The committed copy is the same on every machine, and an interface change
// shows up in code review as a diff of this file.
//
// test/tooling/abi-sync.test.js fails when the committed file differs from
// the compiled contract, so the file cannot go stale unnoticed.
//
// This is a plain Node script: it reads the artifact that Hardhat wrote to
// disk and needs neither the Hardhat runtime nor a network.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ABI_PATH, ARTIFACT_PATH, formatAbi, fromRoot, readCompiledAbi } from "./lib/abi.js";

const abi = await readCompiledAbi();
const text = formatAbi(abi);
const file = fromRoot(ABI_PATH);

// Leave an up-to-date file untouched, so that `npm run compile` does not
// change its modification time when nothing changed.
const previous = await readFile(file, "utf8").catch(() => null);
if (previous === text) {
  console.log(`${ABI_PATH} is up to date (${abi.length} entries).`);
} else {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  console.log(
    `${previous === null ? "Created" : "Updated"} ${ABI_PATH} from ${ARTIFACT_PATH} (${abi.length} entries). Commit it with the contract change.`,
  );
}
