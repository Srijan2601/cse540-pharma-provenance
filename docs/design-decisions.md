# Design decisions and open questions

The proposal (10/25) fixes the architecture but leaves some details open, which the code has to settle. This register lists each gap, the answer the **11/01 draft** proposes, and its status.

**How to use it**

* Settle items by majority vote at the Sunday sync (Team Contract §2). Then change **Status** to `Accepted` or `Changed`, add the date, and update the code and docs in the same PR.
* IDs are referenced from code comments (`PROPOSED (C3)`) and from [`contracts/README.md`](../contracts/README.md).

**Status values:** `Proposed (in draft)` means the draft code already does this, so changing it means editing the interface. `Proposed` is a suggestion not yet in code. `Open` needs a team decision. `Accepted` / `Changed` (with date) once settled.

---

## Contract (C)

| ID | Question | Draft answer | Status |
|---|---|---|---|
| **C1** | Which function causes each status transition, and which event does it emit? Table I has no function that moves a lot from Created to InTransit. | `initiateTransfer`: Created/Stored → InTransit. `acceptTransfer`: → Stored. `updateStatus`: InTransit ⇄ Stored. `markDelivered`: Stored → Delivered, emitting `StatusUpdated`. Each write emits exactly one event (table in `contracts/README.md`). | Proposed (in draft) |
| **C2** | What does "active" mean, which states are terminal, and can a Delivered or Compromised lot be recalled? The proposal conflicts with itself: Fig. 1 says "active -> Compromised \| Recalled" (recall from active lots only), but data flow 4 says the regulator can "recall a lot at any stage". | Active = Created, InTransit, Stored. Delivered, Compromised and Recalled are terminal for custody. `recallBatch` works from any status except Recalled. `issueCertificate` works in any status except Recalled. Entering Compromised or Recalled clears an open hand-off. (Stretch: a regulator `clearExcursion`.) | Proposed (in draft), **needs vote** |
| **C3** | Initiate/accept hand-off rules: who can initiate, to whom, and how a hand-off to a wrong address is undone. | Only the custodian initiates, and only one hand-off per lot can be open. Routes: MANUFACTURER → DISTRIBUTOR; DISTRIBUTOR → DISTRIBUTOR or RETAILER. Custody changes on **accept**. Added `cancelTransfer` and the `TransferCancelled` event, which restore the previous status. | Proposed (in draft). **Open:** allow MANUFACTURER → RETAILER directly? |
| **C4** | Roles gate functions, not lots. How is "REGULATOR (admin)" mapped onto OpenZeppelin? | Every custody action requires the role **and** being the custodian (or pending custodian). The constructor gives the regulator `DEFAULT_ADMIN_ROLE` and `REGULATOR_ROLE`, and the regulator is the admin of the four organization roles. A revoked organization's lots stay where they are and can still be recalled. | Proposed (in draft) |
| **C5** | Batch field types, the ID scheme, duplicate lots, and what "product hash" is a hash of. | IDs are a counter starting at 1. `productHash = keccak256(abi.encode(productCode, lotNumber))`, unique. Origin = the manufacturer's address. `manufactureDate` is passed in and `registeredAt` = block time. Documents are `DocumentRef {cid, contentHash}`. **Risk:** uniqueness is global, so any MANUFACTURER can register, or front-run, another firm's product code + lot number, and `recallBatch` does not free the hash. Options: (a) scope per manufacturer with key = `keccak256(abi.encode(msg.sender, productHash))` and `batchIdOf(address manufacturer, bytes32 productHash)`; (b) the regulator binds product codes to manufacturers. | Proposed (in draft), **needs vote** |
| **C6** | Who certifies? Step 1 has the manufacturer upload "its certificate", but `issueCertificate` is the regulator's. | The manufacturer's certificate of analysis is referenced **inside the metadata JSON**. `certificate` is set only by the regulator through `issueCertificate` and is overwritten each time, with history kept in `CertificateIssued` events. No shipping gate in the MVP. The verify page shows "uncertified" if it is empty. | Proposed (in draft), **needs vote** |
| **C7** | What does the on-chain temperature range do? Units, the excursion rule, and the oracle function signatures. | `int16` in tenths of a °C, set at registration and fixed (2–8 °C = 20..80). `reportExcursion` checks on-chain that the reading is outside the range, then sets Compromised. `anchorSensorLog` stores only the latest log plus a count. The off-chain rule (e.g. K consecutive out-of-range samples) lives in `oracle/`. | Proposed (in draft) |

## Off-chain and integration (O)

| ID | Question | Proposed answer | Status |
|---|---|---|---|
| **O1** | How does the verify page "check IPFS files against their on-chain hashes"? A UnixFS CID is **not** a plain hash of the file's bytes. | Store the CID (to find the file) **plus** `keccak256(exact uploaded bytes)` (to verify it). The page fetches the file, runs `ethers.keccak256(bytes)` and compares. This is built into `DocumentRef`. Never re-serialize JSON after hashing. | Proposed (in draft) |
| **O2** | No schemas for the three IPFS documents (lot metadata, certificate, sensor log). | Add `docs/schemas/*.schema.json`, each with a `schemaVersion`, plus synthetic examples. Use integer tenths of °C and Unix seconds, and include `chainId`, registry address and `lotId` in each document so it can't be reused for another lot. | Open (off-chain lead) |
| **O3** | A pinning-service API key in the React app would ship in the **public** JS bundle. | Pick one: (a) a small upload service that holds the key and returns `{cid, contentHash}`; (b) scoped or short-lived upload tokens; (c) demo-only CLI upload with a pasted CID. Choose one provider and one gateway. | **Open, decide before frontend upload work** |
| **O4** | How do the frontend and oracle get the ABI and address? Plus the local-network fallback. | **Done in the draft:** `scripts/deploy.js` writes `deployments/<network>.json` (address, chainId, deployBlock, txHash, ABI). Still to do: a seed-demo script, a local IPFS fallback with the same CIDs, and a first Amoy deploy around 11/08–11/10. | Partly done |
| **O5** | "Encrypting confidential documents" conflicts with public verification, and public IPFS is not private. | Classify the data. Public plaintext: lot metadata, regulator certificate, sensor logs. Encrypted with AES-256-GCM (keys shared out of band): e.g. invoices and pricing, where the hash covers the ciphertext. Never uploaded: personal data. All fixtures in this repo are synthetic. | Open |
| **O6** | What does `verifyBatch` return, what does the QR code encode, and where does history come from? | `verifyBatch` is a public view returning the `Batch` struct. History comes from events (paged `getLogs` from `deployBlock`). QR = `https://<host>/verify?chain=80002&registry=0x…&lot=<id>`. Host the page publicly, never on localhost, and read it with a keyless RPC. | Proposed |

## Delivery and process (D)

| ID | Question | Proposed answer | Status |
|---|---|---|---|
| **D1** | Definition of done for each deliverable, and a reproducible graded state. | 11/01: `npm ci && npm run compile && npm test` passes on a fresh clone, and the interface declares every Table I function and Fig. 1 event. Tag releases `v0.1-contract-draft`, `v0.2-midterm`, `v1.0-final`. | Proposed |
| **D2** | Nothing enforces "every PR reviewed" and "main always passes tests". | **Done:** `.github/workflows/ci.yml` and a PR template. Still to do: the repo owner adds a branch ruleset on `main` (PRs only, 1 approval, required CI check, no force pushes); set up the GitHub Projects board with Owner, Due and Milestone fields and a `stretch` label. | Partly done |
| **D3** | The integration session and the Canvas submission (48 h early) fall on the same day. | Internal dates. Midterm: freeze 11/11, integrate 11/12, submit 11/13. Final: features complete 11/25, integrate 12/01, submit 12/02. Decide on ERC-721 lot tokens before the struct is final. | Proposed, **needs vote** |
| **D4** | Where QA testing ends and unit testing begins. | Unit and revert tests go in `test/ProvenanceRegistry.test.js`. An end-to-end journey test (data flows 1–5) goes in `test/integration/`. The QA test plan (role × function matrix) and the manual dashboard/QR checklist go in `docs/testing/`. | Proposed |
| **D5** | Analysis method and where the raw data lives. | Gas: `npm run test:gas -- --gas-stats-json docs/analysis/data/gas-<commit>.json`, cross-checked against Amoy receipts and priced at a dated POL price. The centralized-database and Fabric comparisons are qualitative criteria tables. | Proposed |
| **D6** | Where the project log lives. The repo is public. | Attendance, missed commitments and conflicts go in a **private** shared doc. The repo holds only decisions and action items (`docs/meetings/`). Never commit the proposal or team-contract PDF (it contains student IDs). | Proposed |
