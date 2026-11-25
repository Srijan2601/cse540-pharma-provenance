# Test plan

The project is three npm packages, and each has its own tests: the contract (repository root), the oracle (`oracle/`) and the web app (`frontend/`). This page says what each layer checks and how to run it. Run `npm ci` in a package before its first command. The tests need Node.js 22.13 or newer and nothing else: no account, no key and no running chain.

## Counts

Measured on 2026-11-25 on macOS with Node.js 22.18, in clean copies of the repository (no `node_modules`, no build output). Every test passed; none failed or was skipped.

| Suite | Test files | Run in | Command | Tests |
|---|---|---|---|---:|
| Contract, everything | `test/` | root | `npm test` | 495 |
| Contract, unit | `test/unit/` (7) | root | `npm run test:unit` | 462 |
| Contract, integration | `test/integration/` (3) | root | `npm run test:integration` | 17 |
| Contract, Solidity fuzz | `test/solidity/` (5) | root | `npm run test:solidity` | 5 |
| Contract, tooling | `test/tooling/` (3) | root | `npm run test:tooling` | 11 |
| Oracle, unit | `oracle/test/` (13) | `oracle/` | `npm test` | 523 |
| Oracle, end to end | `oracle/test/e2e/` (1) | `oracle/` | `npm run test:e2e` | 3 |
| Web app, unit | `frontend/src/lib/` (11) | `frontend/` | `npm test` | 190 |

`npm run coverage` (root) reports 100% of lines and statements for the four contract files that contain code: `RegistryBase.sol` and the three modules. A coverage run skips the two gas-report checks, because it compiles instrumented code.

## Contract (repository root)

`npm test` runs every layer below in about 12 seconds, on Hardhat's in-process network.

| Layer | Where | What it checks |
|---|---|---|
| Unit, per module | `test/unit/`: `Deployment`, `Registration`, `Custody`, `Condition`, `Certification` | Each function's success path with its one event, and each revert with its custom error and arguments. `Deployment` also checks the constructor, role administration and the public interface against proposal Table I and Fig. 1. |
| Role × function matrix | `test/unit/AccessControl.test.js` | 10 write functions × 7 actors (the five roles, an account with no role, the deployer) = 70 generated tests. An actor without the role gets the exact role error and changes nothing; an actor with the role gets past the role check. |
| Status × function matrix | `test/unit/StateMachine.test.js` | 9 lot states (the six statuses, InTransit in three forms and Stored in two) × the 9 functions that act on an existing lot = 81 generated tests. Each sends one call, asserts its exact outcome, then checks invariants I1 to I5. A seeded random walk of 500 calls checks them after every call. |
| Integration | `test/integration/` | One lot through data flows 1 to 5; journeys off the happy path (excursion, recall during a hand-off and after delivery, a cancelled hand-off, a revoked distributor); and history from events alone: each lot's events, filtered by its ID, rebuild every field of its record that events carry, exactly as `verifyBatch` returns it. |
| Solidity fuzz | `test/solidity/` | Four properties with random inputs (the role check comes first; `registerBatch` succeeds exactly when its inputs are valid; `reportExcursion` succeeds exactly when the reading is out of range; lot IDs are sequential), 128 to 512 runs each, and a random-walk test that checks I1 to I5 after every step of 64 random walks. |
| Tooling | `test/tooling/` | The committed ABI (`deployments/abi/`) equals the compiled contract's; the committed gas report (`docs/analysis/data/`) was measured on the current code; the scripts' CID helper. |

The invariants, stated in `contracts/base/RegistryBase.sol`:

* **I1** An open hand-off implies status InTransit.
* **I2** A Delivered, Compromised or Recalled lot has no open hand-off.
* **I3** Lot IDs are exactly 1 to `totalBatches()`, and `batchIdOf` maps each product hash to its lot.
* **I4** Every lot has a non-zero custodian and manufacturer.
* **I5** Recalled never changes; Delivered and Compromised can only become Recalled.

## Oracle (`oracle/`)

* **Unit tests:** `npm test`, about 9 seconds. They need no chain and no network: remote services are local mock HTTP servers, and the chain is an in-memory stand-in that uses the committed ABI. They cover CIDs and content hashes, the storage back ends, the upload and gateway service, the encryption envelope, the document schemas and builders, configuration, the sensor simulator, the excursion rule (K − 1 readings do not trigger, K do), the runner, the registry client and both command lines.
* **End-to-end test against the real contract:** `npm run test:e2e`, about 13 seconds. It needs the root project installed and compiled first (`npm ci && npx hardhat compile` in the repository root). It starts its own Hardhat node on a free port, deploys `ProvenanceRegistry`, and runs the oracle's own command against it: a normal log is anchored, an excursion makes the lot Compromised, and the chain record, the events and the stored file agree.

## Web app (`frontend/`)

`npm test`, about a second. The tests cover the pure logic in `src/lib/`, with no browser and no network: the reducer from events to a lot's timeline, the verdict rules of the verify page, one message per custom error in the committed ABI, form validation, building and parsing the QR link, which registry a link may name, which actions each role is offered in each status, chart scales, paging of event queries, and formatting. `npm run build` checks that the app builds.

## Continuous integration

`.github/workflows/ci.yml` runs three jobs on every push to `main` and every pull request: `npm ci`, `npx hardhat compile` and `npx hardhat test` in the root; `npm ci` and `npm test` in `oracle/`; `npm ci`, `npm test` and `npm run build` in `frontend/`. The oracle's end-to-end test is not part of it.

## What is not tested automatically

* **The web app's screens.** There is no browser test suite. `frontend/README.md` records that the pages were checked by hand and with a scripted headless browser against a local chain.
* **MetaMask.** The dashboard signs with the local node's test accounts by default. The optional MetaMask path has no test.
* **Polygon Amoy.** No test touches Amoy, and on 2026-11-25 `deployments/` held no Amoy deployment. Deploying to Amoy, the oracle signing with a private key, and the web app reading from Amoy are not covered.
* **The Pinata and Kubo storage options.** Their tests talk to local mock servers. No test contacts Pinata or a real IPFS node; the default is the local store, which needs neither.
