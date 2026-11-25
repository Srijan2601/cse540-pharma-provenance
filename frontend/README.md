# frontend/: organization dashboards and the patient verify page

The web dApp of the project (React, ethers.js v6, Vite). It is its own npm project, independent of the root Hardhat project.

| Page | Route | Who uses it | What it does |
|---|---|---|---|
| Home | `#/` | anyone | Lists every lot with its status and holder, and takes a lot ID to its verify page. |
| Organization dashboard | `#/dashboard` | manufacturer, distributor, pharmacy, regulator | Sign in, then use the functions of the role the account holds on-chain (proposal Table I). |
| Patient verify page | `#/verify?lot=<id>&chain=<chainId>&registry=<address>` | anyone, **no wallet** | Opened from a lot's QR code. Shows a verdict, the lot's facts, documents, history and temperature, and checks every file against its on-chain fingerprint. |

The app has no backend of its own. It reads the registry over JSON-RPC, sends transactions through a signer, and stores and fetches files through the upload + gateway service in [`../oracle/`](../oracle/).

## Quick start (local demo)

Needs Node.js 22.13 or newer. No wallet extension, account, API key, internet connection or `.env` file is needed.

The shortest way is in the repository root: `npm run setup` once, then `npm start -- --seed`, which starts the chain, the file service and this app together and creates five demo lots (see the [root README](../README.md#quick-start)). The steps below start the same parts by hand, one terminal each:

```bash
# terminal 1, repository root: the local chain (port 8545), keep it running
npm ci
npm run node

# terminal 2, repository root: deploy the registry and give the demo accounts their roles
npm run deploy:local        # writes deployments/localhost.json, which the app reads
npm run roles:local         # account #0 regulator, #1 manufacturer, #2 distributor, #3 pharmacy, #4 oracle

# terminal 3: the file service (port 8787), keep it running
cd oracle
npm ci
npm run service

# terminal 4: the app
cd frontend
npm ci
npm run dev                 # http://localhost:5173
```

Open <http://localhost:5173>, go to **Organization dashboard** and pick a local test account.

If the chain is not running, nothing is deployed, or the local chain was restarted (it starts empty every time), each page says so and lists these commands instead of failing. It checks again every few seconds and continues by itself. After restarting `npm run node`, run `deploy:local` and `roles:local` again. If the node stops answering after a page has loaded, the page keeps what it shows, under a short "connection lost" notice, so nothing typed or shown once (such as the key of a confidential attachment) is lost to a dropped request.

The app may be started before the registry is deployed: the dev server notices a `deployments/localhost.json` that is written while it is running. A built app (`npm run build`) reads the deployment record at build time, so build it again after deploying.

## Signing in

| Way | When | How it works |
|---|---|---|
| **Local test account** (default) | only on the local chain, chain id 31337 | The menu lists the local Hardhat node's own funded test accounts, labelled with the roles they hold on-chain right now (`hasRole`). The node holds their keys and signs for them (`JsonRpcProvider.getSigner`), so the app never sees a private key and no wallet is needed. |
| **MetaMask** (optional) | any chain with a known deployment | "Connect MetaMask" uses `window.ethereum`. The dashboard follows the wallet's account and chain. If the wallet is on a chain where this app knows no registry, it says so. |

The patient never signs in. A session lives in memory only: reloading the page signs out.

## What each role does

Every button sends one transaction. Before sending, the app **simulates** the call; if the contract would revert, it shows a plain-language sentence for the custom error and sends nothing. Buttons are offered only when the contract would accept the call for that lot and account. The result appears next to the lot or form it concerns. If that lot has left the account's lists in the meantime (for example, the sender cancelled a hand-off just before Accept was clicked), the result appears above the panels instead. A success message goes away after a few seconds, and signing in as another account starts with none.

| Role (contract role) | Panel | Functions |
|---|---|---|
| Manufacturer (`MANUFACTURER_ROLE`) | **Register a lot**: product code, product name, lot number, manufacturer, site, manufacture and expiry date, allowed temperature range, one optional attachment with "Confidential: encrypt before upload". **My lots**: start a hand-off (pick a distributor or paste an address), cancel an open hand-off, show the QR code. | `registerBatch`, `initiateTransfer`, `cancelTransfer` |
| Distributor (`DISTRIBUTOR_ROLE`) | **Incoming hand-offs**: accept. **Lots I hold**: mark as in transit / stored, start a hand-off to a distributor or pharmacy, cancel it. | `acceptTransfer`, `updateStatus`, `initiateTransfer`, `cancelTransfer` |
| Pharmacy (`RETAILER_ROLE`) | **Incoming hand-offs**: accept. **Lots I hold**: verify (opens the verify page), mark delivered. | `acceptTransfer`, `verifyBatch`, `markDelivered` |
| Regulator (`REGULATOR_ROLE`) | **Organizations**: who holds which role; grant or revoke one of the four organization roles for any address. **All lots**: issue a certificate, or recall a lot (with a confirmation step, because a recall is final). | `grantRole`, `revokeRole`, `issueCertificate`, `recallBatch` |
| IoT oracle (`ORACLE_ROLE`) | A note only: the oracle is the Node.js program in `oracle/` (`npm run oracle`, `npm run oracle:once -- --lot <id> [--scenario excursion]`). | `anchorSensorLog`, `reportExcursion` (not sent from the app) |
| No role | The account's address, to give to the regulator. | none |

**Registering a lot**, step by step: the form is checked; the product code and lot number are looked up with `batchIdOf` so a duplicate is refused before anything is uploaded; the attachment, if any, is uploaded (encrypted first in the browser when marked confidential); the lot-metadata document is built with the shared builder from `oracle/src/documents/` and its exact bytes are uploaded; the fingerprint returned by the service is compared with the one computed in the browser; `registerBatch` is simulated and sent; the new lot's ID and QR code are shown.

**A confidential attachment** is encrypted with AES-256-GCM (`oracle/src/crypto/envelope.js`). The key is generated in the browser and shown **once**, with a copy button. It is never uploaded, stored or put on-chain; share it privately. The fingerprint recorded for the attachment covers the encrypted bytes, so anyone can check its integrity and only key holders can read it.

**The manufacture date** is stored as midnight UTC of the chosen day. The contract rejects a date later than the block time, so when midnight UTC of "today" is still ahead of the chain's clock, the chain's current time is recorded instead.

A demo walk-through on a freshly deployed local chain: as the regulator (#0), look at **Organizations** and grant the Distributor role to account #6 (the second distributor of `scripts/demo.js` and of the seeded demo, where it already holds the role; account #5 is left without a role on purpose, as the outsider of `npm run demo:local`); as the manufacturer (#1), register a lot and hand it to #6 by mistake, cancel, hand it to #2; as the distributor (#2), accept, mark as in transit, mark as stored, hand off to the pharmacy; as the pharmacy (#3), accept and mark delivered; as the regulator, issue a certificate; open the lot's verify page. In `oracle/`, `npm run oracle:once -- --lot <id> --scenario excursion` on an active lot turns its verify page red within a few seconds.

Lots created by `scripts/demo.js` (`npm run demo:local`) reference documents that the script keeps in memory and never uploads. Their verify pages show the on-chain record and history, and report the files as "could not be fetched".

## How the verify page checks a lot

1. **The link.** The lot ID must be a positive whole number. `chain` and `registry` are optional and default to the deployment the app knows. If the link names a chain or a registry the app does **not** know, the page shows a warning and reads nothing: a counterfeiter can deploy a registry of their own and print a QR code for it.
2. **The record.** `verifyBatch(lotId)` and the lot's events are read over read-only RPC, both as of the same block. Events are fetched with a topic filter on the lot ID, from the deployment block, in pages of a fixed number of blocks (public RPC endpoints cap the range). Replaying the events must give the status and custodian that `verifyBatch` returned; otherwise the page says the history may be incomplete.
3. **The files.** For the lot metadata, the current certificate and every sensor log, the page downloads `<gateway>/<cid>`, hashes the bytes with keccak256 and compares the result with the on-chain `contentHash`. Each file is shown as "Matches the on-chain fingerprint", "DOES NOT MATCH" or "Could not be fetched". Only a matching file is parsed, and its content is used only if it validates against its JSON Schema (`docs/schemas/`) and is about this lot (chain, registry, lot ID, product hash). Attachments are listed only from documents that passed, and are checked against the fingerprint those documents record.
4. **The verdict**, first match wins:

   | Situation | Banner |
   |---|---|
   | Lot is Recalled | **Do not use: recalled by the regulator**, with the reason |
   | Lot is Compromised | **Do not use: a temperature excursion was recorded**, with the reading and the allowed range |
   | A file does not match | **Record problem: a file does not match its fingerprint** |
   | otherwise | **Record verified**, with the status in words, for example "Delivered by the pharmacy." |

   A missing regulator certificate and files that could not be fetched are shown as separate neutral notes. When none of the files could be fetched, the note starts with "Only the blockchain record was verified", so the banner is not read as covering the product details. Every banner has its own icon and wording; nothing is signalled by colour alone.
5. **Refresh.** The page re-reads the chain every few seconds, so an excursion or a recall appears without reloading. A file check is repeated when the page is reloaded.

The project's own gateway re-hashes each file it serves and answers with an error when its stored copy was changed. The page reports that as "DOES NOT MATCH" too, so editing a file in `oracle/.ipfs-store/` and reloading the verify page shows the tamper evidence.

Everything read from IPFS or typed by another organization is treated as untrusted: it is rendered as text only, file links are built only from a CID that parses, and attachments are always offered as downloads, never displayed.

## Configuration

All settings are optional. The defaults are the local demo. Vite compiles `VITE_*` values into the public JavaScript bundle, so **never put a secret in one**.

| Variable | Default | Meaning |
|---|---|---|
| `VITE_LOCAL_RPC_URL` | `http://<host of the page>:8545` | JSON-RPC endpoint of the local chain (chain id 31337). |
| `VITE_LOCAL_REGISTRY_ADDRESS` | `address` in `../deployments/localhost.json` | Registry address on the local chain; overrides the deployment record. |
| `VITE_LOCAL_DEPLOY_BLOCK` | `deployBlock` in `../deployments/localhost.json`, else `0` | Block from which event history is read on the local chain. |
| `VITE_UPLOAD_SERVICE_URL` | `http://<host of the page>:8787` | The upload + gateway service of `oracle/` (`npm run service`). |
| `VITE_IPFS_GATEWAY_URL` | `<upload service>/ipfs/` | Where files are downloaded from; a CID is appended. |
| `VITE_AMOY_RPC_URL` | `https://polygon-amoy-bor-rpc.publicnode.com` | Keyless RPC endpoint for Polygon Amoy. Used only if `../deployments/amoy.json` exists. This endpoint accepts event queries of up to 10,000 blocks; `polygon-amoy.drpc.org` refuses any over 100 blocks on its free plan, which the history query of the verify page exceeds (both checked on 2026-11-25). |
| `VITE_VERIFY_BASE_URL` | the page's own origin and path | The address QR codes point at. |

Set them on the command line, for example `VITE_LOCAL_RPC_URL=http://127.0.0.1:8546 npm run dev`, or in a file `frontend/.env.local` that you create yourself (Vite loads it; the root `.gitignore` keeps it out of git). No such file exists in the repository and none is needed.

The default addresses use the host name the page was loaded from, not a fixed `127.0.0.1`, so a phone that opened the page from the laptop's network address talks to the laptop's node and file service.

Two values are constants in [`src/lib/networks.js`](src/lib/networks.js) instead of settings: the page size of event queries in blocks (`LOG_CHUNK_BLOCKS`, per network) and the refresh interval (`POLL_MS`).

**Which chain the app uses.** The local chain, whenever a local registry is known (from `deployments/localhost.json` or `VITE_LOCAL_REGISTRY_ADDRESS`). Polygon Amoy becomes the default only when `deployments/amoy.json` exists and nothing local is configured. A connected MetaMask wallet switches the dashboard to the wallet's chain if a deployment is known there. A verify link names its chain itself.

The contract ABI is read from the committed [`../deployments/abi/ProvenanceRegistry.json`](../deployments/abi/ProvenanceRegistry.json), never from Hardhat's `artifacts/` folder.

## npm scripts

| Script | Does |
|---|---|
| `npm run dev` | Development server on <http://localhost:5173>. |
| `npm run build` | Production build into `dist/` (static files; any static host can serve them). |
| `npm run preview` | Serves the built `dist/` on <http://localhost:4173>. |
| `npm test` | Unit tests with Vitest. |

The file service accepts uploads from `http://localhost:5173`, `http://127.0.0.1:5173` and the same two hosts on port 4173 by default. If you serve the app from another origin, add it to `IPFS_SERVICE_CORS_ORIGINS` of the service (see [`../oracle/README.md`](../oracle/README.md)); otherwise uploads are refused with HTTP 403.

## Tests

```bash
cd frontend
npm test
```

About 190 tests in 11 files, a second or two, no network and no browser. They cover the logic in `src/lib/`, which has no React in it:

| File | Covers |
|---|---|
| `history.test.js` | The reducer from events to timeline: scripted event sequences must reproduce the contract's status and custodian (hand-off, cancel, status updates, excursion, recall), and the wording of each entry. |
| `verdict.test.js` | Every verdict rule, their priority, and the neutral notes. |
| `errors.test.js` | One sentence for every custom error **in the committed ABI** (the test fails if the contract gains an error the table does not know); wallet, node and file-service failures. |
| `forms.test.js` | Form validation; the documents the forms produce validate against the JSON Schemas through the shared builders; manufacture date of "today"; reading and rejecting downloaded documents. |
| `lotDocuments.test.js` | Which files a lot has; content is used only from a matching, valid document of the lot. |
| `actions.test.js` | Which buttons are offered for a lot, per role and state. |
| `verifyLink.test.js` | QR link build and parse, malformed links. |
| `networks.test.js` | Where the registry address comes from, the default chain, which verify links are trusted. |
| `temperature.test.js` | Chart scales, ticks and band; ordering of readings. |
| `blockRanges.test.js` | Paging of event queries. |
| `format.test.js` | Temperatures, dates, addresses, role identifiers. |

There is no browser test suite in the repository; the pages were checked by hand and with a scripted headless browser against a local chain.

## Project layout

```
frontend/
├── index.html, vite.config.js      entry page; aliases to ../oracle/src, ../docs/schemas, ../deployments
├── package.json, package-lock.json dependencies: react, react-dom, react-router-dom, ethers, qrcode, ajv
└── src/
    ├── main.jsx, App.jsx           mount point; routes (HashRouter)
    ├── config.js                   the only reader of VITE_* settings, deployment records and window.location
    ├── lib/                        pure logic, unit tested, no React and no network
    │   ├── constants.js            statuses and roles, with the words shown for them
    │   ├── networks.js             known deployments; which verify links are trusted
    │   ├── verifyLink.js           QR link build / parse
    │   ├── history.js              events -> timeline, status, custodian, documents
    │   ├── verdict.js              verdict rules of the verify page
    │   ├── lotDocuments.js         a lot's files and what may be concluded from each
    │   ├── documents.js            shared validator and builders, bound to the bundled schemas
    │   ├── forms.js                form values -> documents and contract arguments
    │   ├── actions.js              which actions the contract would accept
    │   ├── errors.js               custom error -> plain sentence
    │   ├── temperature.js          chart arithmetic
    │   ├── blockRanges.js          paging of event queries
    │   └── format.js               temperatures, dates, addresses
    ├── chain/                      everything that talks to a node, a wallet or the file service
    │   ├── provider.js             read-only providers; the registry contract (ABI from ../deployments/abi)
    │   ├── registry.js             is the registry there, lots, roles, chain time
    │   ├── history.js              paged, incremental event reading; a lot's record; the organization directory
    │   ├── operations.js           simulate-then-send; register a lot; issue a certificate; decrypt
    │   ├── files.js                upload; download and compare with the fingerprint
    │   └── wallet.js               MetaMask (window.ethereum)
    ├── state/session.jsx           who is signed in, on which chain
    ├── hooks/                      usePolling, useLots, useFileChecks
    ├── components/                 Layout, RegistryGate, Notice, CommandSteps, Field, Labels, Icon, QrCode
    │   ├── dashboard/              SignIn, ActionRunner, LotRow, RegisterLotForm, CustodyPanels, RegulatorPanel
    │   └── verify/                 VerdictBanner, LotFacts, Documents, Timeline, TemperatureChart
    ├── pages/                      HomePage, DashboardPage, VerifyPage
    └── styles/                     base.css (tokens, shell), components.css, verify.css
```

**Shared code instead of copies.** The encryption envelope, CID and content-hash functions, upload-service client, document validator and builders are imported from `../oracle/src/` (they have no Node-only imports), the JSON Schemas from `../docs/schemas/`, and the ABI from `../deployments/`. `resolve.dedupe` in `vite.config.js` makes those shared files use the `ethers` and `ajv` installed here, so `oracle/node_modules` does not have to exist to build or test the app.

No fonts, scripts or images are loaded from the internet. Styles are plain CSS with variables; there is no UI or CSS framework and no state library.

## Optional: the verify page on a phone

The phone must reach the laptop's dev server, node and file service, so all three have to listen on the network, and the QR code must contain the laptop's address instead of `localhost`. `npm start -- --seed --lan` in the repository root sets all of that up and prints the address to open. By hand:

```bash
npx hardhat node --hostname 0.0.0.0                            # repository root, instead of npm run node
IPFS_SERVICE_HOST=0.0.0.0 npm run service                      # in oracle/
VITE_VERIFY_BASE_URL=http://<laptop address>:5173/ npm run dev -- --host    # in frontend/
```

Use this only on a network you trust: the test accounts and the upload endpoint are then reachable by everyone on it. Decrypting a confidential attachment needs the browser's WebCrypto API, which browsers offer only on `https` or `localhost`; on the phone the decrypt field says so and asks you to decrypt on the laptop itself, and the fingerprint checks and everything else work. This set-up was not tried on a real phone.

## Optional: MetaMask and Polygon Amoy

* **MetaMask on the local chain.** Add the network (RPC URL `http://127.0.0.1:8545`, chain ID `31337`, currency `ETH`) and import test accounts with the private keys that `npm run node` prints when it starts (`npm start` hides them; the accounts are the same). Those keys are public; never use them on a real network or send real funds to them. After restarting the local chain, clear the accounts' activity in MetaMask (*Settings → Advanced → Clear activity tab data*) so the nonces start again. The MetaMask sign-in has not been verified: the button exists, and every check of the app used the local test accounts.
* **Polygon Amoy.** Once `../deployments/amoy.json` is committed, the app knows the Amoy registry: verify links with `chain=80002` work, and a MetaMask wallet on Amoy can use the dashboard. Reading goes through `VITE_AMOY_RPC_URL`. Files still need a reachable upload service and gateway: set `VITE_UPLOAD_SERVICE_URL` and `VITE_IPFS_GATEWAY_URL`. If the RPC endpoint rejects event queries, lower `LOG_CHUNK_BLOCKS` for Amoy in `src/lib/networks.js`. No Amoy deployment existed when this was written, so the Amoy path has not been run against the live network.

## Limits, on purpose

* The lists read `totalBatches()` and then `verifyBatch(id)` for every lot. That is fine for a demo's handful of lots; a large registry would need paging or an indexer.
* Role names in the history are the roles an address holds **now**. An organization whose role was later revoked is shown as "Organization".
* The certificate shown under Documents is the current one. Earlier certificates remain in the history as "Certificate issued" entries.
* One attachment per lot can be added when registering. A regulator certificate is created without attachments.
