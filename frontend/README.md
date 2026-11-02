# frontend/: role-based web dApp + patient verify page

**Status:** not started. This folder will hold its own npm project (React + ethers.js v6). It is independent of the root Hardhat project.

## What goes here

| Part | Users | Does |
|---|---|---|
| Role dashboards | Manufacturer, Distributor/3PL, Pharmacy, Regulator (MetaMask, one wallet per organization) | Connect the wallet, detect the role (`hasRole`), and show only that role's actions (proposal Table I). |
| Manufacturer view | MANUFACTURER | Upload lot metadata to IPFS (see **O3**), `registerBatch`, start hand-offs, generate the lot's QR code. |
| Distributor / pharmacy views | DISTRIBUTOR, RETAILER | Incoming hand-offs (`pendingCustodian == me`), `acceptTransfer`, `updateStatus`, `markDelivered`. |
| Regulator view | REGULATOR | Onboard organizations (`grantRole` / `revokeRole`), `issueCertificate`, `recallBatch`. |
| **Patient verify page** | Anyone, **no wallet** | Opened from the QR code. Reads `verifyBatch` and the lot's event history over read-only RPC, fetches IPFS files and checks `keccak256(bytes) == contentHash` (**O1**). Shows custody, certificate and temperature log. |

## How it talks to the contract

* **Address + ABI:** read from `../deployments/<network>.json`, which `npm run deploy:local` or `npm run deploy:amoy` writes at the repo root. Copy the file into `src/contracts/` or import it at build time. Never import Hardhat's `artifacts/` folder, because it is gitignored.
* **History:** every event indexes `batchId`. Query `registry.queryFilter(..., deployBlock)` in pages, because public Amoy RPCs limit how many blocks one query can cover (**O6**).
* **Function and event reference:** [`../contracts/README.md`](../contracts/README.md).

## Planned config: `frontend/.env.example`

Vite exposes only `VITE_*` variables, and **they are compiled into the public JS bundle**. Never put a secret here.

| Variable | Example | Notes |
|---|---|---|
| `VITE_CHAIN_ID` | `80002` (Amoy) or `31337` (local) | Selects the deployment file and the MetaMask network. |
| `VITE_READ_RPC_URL` | `https://rpc-amoy.polygon.technology` | Keyless or origin-restricted only. Used by the wallet-less verify page. |
| `VITE_IPFS_GATEWAY_URL` | `https://<gateway>/ipfs/` | The same gateway the oracle uses. |
| `VITE_VERIFY_BASE_URL` | `https://<host>/verify` | Encoded in each QR code. Must be reachable from a phone, so never `localhost`. |
| `VITE_UPLOAD_SERVICE_URL` | `https://<upload-service>` | Only if **O3** picks an upload service. The pinning key never reaches the browser. |

## Tasks

- [ ] **By 11/08:** scaffold (`npm create vite@latest`, React), wallet connect, network switch to Amoy (chainId 80002) and local (31337)
- [ ] **By 11/08:** read `deployments/<network>.json` and show `totalBatches()` / `verifyBatch(id)` as a first end-to-end read
- [ ] **By 11/13 (midterm):** manufacturer register flow and the transfer initiate/accept flow on Amoy
- [ ] **By 11/13:** QR code per lot (URL format in **O6**), verify page with custody history from events
- [ ] **By 11/25:** regulator view; IPFS fetch and hash check on the verify page; Compromised / Recalled / uncertified states clearly flagged
- [ ] **By 12/02:** host the verify page publicly (GitHub Pages or Vercel), demo walkthrough, screenshots for the report
