# docs/

Project documentation, analysis, report and meeting notes. **This repo is public:** no ASU IDs, emails, private keys, or the proposal/team-contract PDF (it contains student IDs).

## Contents

| Path | What | Status |
|---|---|---|
| [`design-decisions.md`](design-decisions.md) | Register of design gaps in the proposal (C1–C7, O1–O6, D1–D6), with the draft's proposed answers and their status | ✅ started 11/01 |
| [`meetings/`](meetings/) | Sunday sync notes: decisions and action items only. Copy [`meetings/TEMPLATE.md`](meetings/TEMPLATE.md) to `meetings/YYYY-MM-DD.md` | ✅ template |
| `schemas/` | JSON Schemas + **synthetic** examples for the IPFS documents: lot metadata, certificate, sensor log (**O2**) | ⏳ by 11/08 |
| `testing/` | QA test plan (role × function matrix, transition table, event checklist) and the manual dApp/QR checklist (**D4**) | ⏳ by 11/12 |
| `demo/` | Demo runbook for Amoy and the local-Hardhat fallback; video links (unlisted; don't commit video files) | ⏳ by 11/12 |
| `analysis/` | The five analysis topics from proposal §6 (gas cost, scalability, privacy, regulation, centralized comparison) plus the trusted-key analysis from §2. Raw data in `analysis/data/` (**D5**) | ⏳ data after 11/25 |
| `report/` | Final IEEE-format report: outline, section owners, figures (or a link to the Overleaf project) | ⏳ due 12/04 |

Create a folder when its first file is ready. Git does not track empty folders.

## Analysis plan (proposal §2, §6)

| Topic | Method | Data source |
|---|---|---|
| Gas cost | Per-function and per-lot lifecycle cost, at a dated POL price | `npm run test:gas -- --gas-stats-json docs/analysis/data/gas-<commit>.json`, cross-checked against Amoy tx receipts |
| Scalability | Storage growth per lot (latest-only storage + events), event-query limits on public RPCs | Contract design + measurements |
| Privacy | What is public on-chain vs on IPFS vs encrypted vs never uploaded (**O5**) | Data classification table |
| Regulation | Fit with U.S. DSCSA electronic tracing requirements and FDA exemptions (proposal ref. [2]) | Literature |
| Centralized comparison | Qualitative criteria table: shared DB vs Fabric vs public chain (trust, auditability, cost, patient access) | Literature + our numbers |
| Trusted keys | What the regulator key and the oracle key can and cannot do (see `contracts/README.md`) | Contract roles |
