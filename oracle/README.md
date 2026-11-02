# oracle/: IoT sensor simulator, oracle script, IPFS storage

**Status:** not started. This folder will hold its own Node.js 22 npm project. It is independent of the root Hardhat project. Real sensors are **out of scope** (proposal §6); readings are simulated.

## What goes here

| Part | Does |
|---|---|
| **Sensor simulator** | Generates temperature readings per lot from repeatable scenarios (`normal`, `excursion`) so the demo behaves the same every time. |
| **Oracle script** | Signs with the **ORACLE** wallet. Batches readings into a sensor-log JSON file, uploads it to IPFS, then calls `anchorSensorLog(batchId, {cid, contentHash})`. When the excursion rule triggers, calls `reportExcursion(batchId, readingTenthsC, observedAt, {cid, contentHash})`, which sets the lot **Compromised**. |
| **IPFS helpers** | Upload/pin through the chosen pinning service and return `{cid, contentHash = keccak256(exact bytes)}` (**O1**). Encrypt confidential documents before upload (proposal §5); which documents count as confidential is still open (**O5**). The upload path for the dApp depends on **O3**. |

## Contract interface used

```solidity
function anchorSensorLog(uint256 batchId, DocumentRef calldata sensorLog) external;          // ORACLE, active lots
function reportExcursion(uint256 batchId, int16 readingTenthsC, uint64 observedAt,
                         DocumentRef calldata sensorLog) external;                           // ORACLE, reading must be out of range
event SensorLogAnchored(uint256 indexed batchId, uint32 indexed logIndex, string cid, bytes32 contentHash);
event ExcursionReported(uint256 indexed batchId, uint32 logIndex, int16 readingTenthsC, uint64 observedAt,
                        string logCid, bytes32 logContentHash);
```

* Temperatures are **integers in tenths of a degree C** (5.4 °C → `54`). Solidity has no decimals (**C7**).
* The contract rejects an excursion whose reading lies inside the lot's registered range (`ReadingWithinRange`).
* Address + ABI come from `../deployments/<network>.json` (written by `npm run deploy:*`).
* Get `ORACLE_ROLE` with `npm run roles:local` or `npm run roles:amoy` (set `ORACLE_ADDRESS`).

## Planned config: `oracle/.env.example`

| Variable | Secret? | Notes |
|---|---|---|
| `NETWORK` | no | `amoy` or `localhost`. Selects `deployments/<network>.json`. |
| `RPC_URL` | if it contains a key | Amoy RPC, or `http://127.0.0.1:8545` for the local fallback. |
| `ORACLE_PRIVATE_KEY` | **yes** | A dedicated testnet wallet that holds **only** ORACLE_ROLE. Never reuse it, and never put it in the frontend. |
| `IPFS_PINNING_TOKEN` | **yes** | Pinning-service JWT or API key. Node-side only. |
| `IPFS_GATEWAY_URL` | no | The same gateway as the frontend. |
| `SIM_SCENARIO` / `SIM_INTERVAL_SECONDS` | no | Selects a scenario and sets the reading interval. |

> ⚠️ The root `.gitignore` (Node template) ignores every `logs/` folder and `*.log` file. Keep sample data as `.json` in a folder named something like `scenarios/`, not `logs/`.

## Off-chain document formats (to define, **O2**)

The verify page hashes the **exact bytes**, so the JSON format must be fixed and never re-serialized after hashing. Put schemas and synthetic examples in `docs/schemas/`:

- `lot-metadata.schema.json`: product code, lot number, site, expiry, manufacturer's certificate of analysis
- `certificate.schema.json`: issuer, scope, issue date
- `sensor-log.schema.json`: `schemaVersion`, `chainId`, `registry`, `lotId`, readings `[{t, tenthsC}]`

## Tasks

- [ ] **By 11/08:** settle **O1**, **O2** and **O3** with the team; pick the pinning provider and gateway
- [ ] **By 11/08:** scaffold the Node project; upload helper returning `{cid, contentHash}`
- [ ] **By 11/13 (midterm):** simulator with `normal` and `excursion` scenarios; oracle anchors logs on Amoy
- [ ] **By 11/13:** excursion rule (e.g. K consecutive out-of-range samples) → `reportExcursion`
- [ ] **By 11/25:** local fallback (local IPFS node pre-pinned with the same files, so CIDs match); encryption of confidential documents (proposal §5, **O5**)
- [ ] **By 12/02:** inputs for the trusted-oracle and IPFS cost sections of the analysis
