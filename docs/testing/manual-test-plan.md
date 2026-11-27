# Manual test plan

A checklist for running the whole system by hand on a fresh machine: the automated suites, the web app, the terminal demo and, optionally, Polygon Amoy. It complements [the test plan](README.md) in this folder, which describes the automated tests and lists what they do not cover. The web app's screens, the Amoy scripts and the web app reading from Amoy have no automated test, so this plan is how they are checked.

**What has been run so far.** Parts 1 to 4 were checked on macOS with Node.js 22.18 on 2026-11-25, and the local system was also checked on Fedora Linux with Node.js 22.23.1 that day; CI runs the three unit suites of part 2 on Ubuntu. Part 5 was run on the real network on 2026-11-26 from Fedora Linux: `npm run deploy:amoy` created the registry at `0x603E9669D24BFf7c073ECcea36d203A453d49664` (block 53923451), one `npm run demo:amoy` run sent 29 transactions with the 26 refused calls simulated, and the record was committed. Part 6 was done once the same day. `npm run roles:amoy` and `npm run verify:amoy` have not been run on the real network (`roles:amoy` was rehearsed on 2026-11-25 against a local node given Amoy's chain ID, 80002). Nothing here was tried on Windows. Details: [`../amoy-deployment.md`](../amoy-deployment.md#what-was-run).

For each part, note pass or fail. On a failure, keep the terminal output or a screenshot. [Recording a run](#recording-a-run) at the end lists what to write down.

## Before you start

You need Node.js 22.13 or newer (it includes npm), Git and a browser. Parts 1 to 4 need no wallet, no account, no API key and no `.env` file. Part 5 needs a new testnet wallet (MetaMask can create one) and free test POL; part 6 needs neither.

## 1. Get the code and install

```bash
git clone https://github.com/Srijan2601/cse540-pharma-provenance.git
cd cse540-pharma-provenance
npm run setup
```

* To test a pull request, switch to its branch before `npm run setup`: `git switch <branch>`.
* In an older clone, run `git pull` and then `npm run setup` again; the packages in `oracle/` and `frontend/` are installed by it. If the folder holds a `.env` file from an earlier setup, delete it: its values override the Hardhat keystore that part 5 uses.
* **Expected:** the command ends without an error. Two `npm warn deprecated` lines (`inflight`, `glob`) are normal. Do not run `npm audit fix`, with or without `--force`.

## 2. Automated tests

```bash
npm test
cd oracle
npm test
npm run test:e2e
cd ../frontend
npm test
cd ..
```

| Suite | Command | Expected |
|---|---|---|
| Contract | `npm test` in the root | `495 passing (5 solidity, 490 mocha)` |
| Oracle | `npm test` in `oracle/` | 523 passing |
| Oracle against the real contract | `npm run test:e2e` in `oracle/` | 3 passing; it starts its own Hardhat node on a free port |
| Web app | `npm test` in `frontend/` | 190 passing |

## 3. The web app on the local chain

```bash
npm start -- --seed
```

**Expected:** after a few seconds the terminal prints a summary with the addresses to open, the local test accounts and five seeded lots, and stays in the foreground. <http://localhost:5173> lists lots 1 to 5 as Delivered, In transit, Compromised, Recalled and Stored.

Then follow the 14 steps of the [demo walkthrough](../../README.md#demo-walkthrough) in the root README. Every step has a *See:* line with the text that should appear; note each step where the screen differs. The five checks that matter most:

| Check | Walkthrough steps | Expected |
|---|---|---|
| The patient's view needs no sign-in | 2 | Lot 1 shows "Record verified", seven files that each match their fingerprint, the custody history, the temperature chart and the QR code |
| Every role acts | 4, 5, 7 to 10 | The regulator grants a role; the manufacturer registers lot 6; it is handed to the distributor and then to the pharmacy, delivered, and certified |
| A forbidden action is refused | 6 | Handing a lot from the manufacturer straight to the pharmacy shows "… cannot receive this lot", and no transaction is sent |
| The oracle updates an open page | 11 | After `npm run oracle:once -- --lot 5 --scenario excursion` in a second terminal, the page of lot 5 changes to "Do not use: a temperature excursion was recorded" without a reload |
| A changed file is detected | 13 | After a stored file is edited, the page reports "Record problem: a file does not match its fingerprint" |

Stop with Ctrl+C in the first terminal. **Expected:** "Stopped. Ports 8545, 8787, and 5173 are free."

If the start fails:

| Message | Cause |
|---|---|
| "… already in use" | Another copy of the demo is running, or another program holds port 8545, 8787 or 5173 |
| "Run this once, then start again: npm run setup" | Part 1 was skipped or did not finish |
| A message about the Node.js version | Node.js is older than 22.13 |

## 4. The contract in a terminal

```bash
npm run demo
```

Needs nothing running. **Expected:** 19 steps with two lots, 25 transactions marked `OK`, 26 refused calls marked `BLOCKED` with the name of their custom error, then the patient's view of both lots rebuilt from events. The script exits with code 0.

## 5. Polygon Amoy (optional)

This part sends real transactions on a public testnet from **one** free testnet wallet. It costs no money. The background is in the [Polygon Amoy section](../../README.md#polygon-amoy) of the root README, and the cost figures are in [`docs/amoy-deployment.md`](../amoy-deployment.md).

**The committed deployment stays as it is.** `deployments/amoy.json` holds the project's deployment of 2026-11-26, and `npm run demo:amoy` runs only from the wallet that deployed the registry in that file: it stops if its wallet is not that registry's regulator. A tester with another wallet therefore deploys a registry of their own in step 4. That overwrites `deployments/amoy.json` in the working copy; do not commit it unless the project moves to the new registry (`git restore deployments/amoy.json` brings the committed record back). To look at the committed deployment without a wallet, go to part 6.

1. **Wallet.** Create a new wallet that is used for nothing else, for example a new MetaMask account. Never use a wallet that holds real funds.
2. **Test POL.** Get at least 0.4 POL into the wallet (0.5 POL leaves room for a second run) from an Amoy faucet such as <https://faucet.polygon.technology>, which worked on 2026-11-26 after signing in with GitHub or X. The deployment and one demo run of 2026-11-26 cost about 0.25 POL together, and the first demo run does not start with less than about 0.25 POL left in the wallet ([`../amoy-deployment.md`](../amoy-deployment.md#cost)). Skip every faucet that asks for a balance on a real network; on 2026-11-24 the Alchemy, Chainstack, GetBlock and QuickNode faucets did. Never buy test tokens and never type a seed phrase into a faucet page. Check the balance at `https://amoy.polygonscan.com/address/<wallet address>`.
3. **Endpoint and key.** Store both in Hardhat's encrypted keystore, which lives in your user profile, outside the repository. The first command asks you to choose a password; every later Amoy command asks for it.
   ```bash
   npx hardhat keystore set AMOY_RPC_URL           # paste https://polygon-amoy-bor-rpc.publicnode.com
   npx hardhat keystore set DEPLOYER_PRIVATE_KEY   # paste the wallet's private key (input is hidden)
   ```
4. **Deploy.**
   ```bash
   npm run deploy:amoy
   ```
   **Expected:** the transaction hash and the registry's address as soon as the transaction is sent, each with its `amoy.polygonscan.com` link, then "Saved deployments/amoy.json" (your own record, in place of the committed one).
5. **Run the demo.**
   ```bash
   npm run demo:amoy
   ```
   **Expected:** step 0 prints what the run will cost and stops, before anything is sent, if the balance is too low. Otherwise the 19 steps of part 4 follow in single-wallet mode: 29 transactions on a first run against a new registry (25 registry calls and 4 top-ups, as in the run of 2026-11-26), each with its explorer link, and a list of all of them at the end.
6. **Record the deployment.** Only if the project moves to the new registry: commit `deployments/amoy.json` and, in the same pull request, update every document that names the old address ([`deployments/README.md`](../../deployments/README.md#networkjson-one-deployment) lists them). This was done for the deployment of 2026-11-26.

If a command fails, keep its output before trying again: every attempt spends test POL. Never put the private key or the seed phrase in a file of this repository, a commit, a chat message or a screenshot.

## 6. The web app reading from Amoy (optional)

Needs no wallet and no part 5: the committed deployment holds lots 1 and 2. Start the app with `npm start`, then open this address (if you deployed a registry of your own in part 5, put its address in place of the committed one):

```text
http://localhost:5173/#/verify?lot=1&chain=80002&registry=0x603E9669D24BFf7c073ECcea36d203A453d49664
```

**Expected:** the lot's status and its history load from the public chain through the keyless endpoint. The documents show "Could not be fetched, so it was not checked": `scripts/demo.js` keeps the files it references in memory and uploads them nowhere, so no gateway has them. On 2026-11-26 this was checked against the committed deployment, with this result.

## What this plan leaves out

* **MetaMask sign-in to the dashboards.** The button exists and has never been exercised. The plan uses the local test accounts.
* **A phone scanning the QR code.** `npm start -- --seed --lan` was checked only from the laptop itself. See the notes under the demo walkthrough.
* **The Pinata and Kubo storage options.** The default local store needs neither.

## Recording a run

Write down the following and post it in the pull request or the team channel. Nothing in it is secret.

* Date, operating system and the output of `node --version`
* The commit that was tested: `git rev-parse --short HEAD`
* The table below, with the output or a screenshot for every failure
* For part 5, the full terminal output of both commands (it holds addresses and explorer links, and no key)

| Part | Result | Notes |
|---|---|---|
| 1. Install | | |
| 2. Contract tests (495) | | |
| 2. Oracle tests (523, then 3) | | |
| 2. Web app tests (190) | | |
| 3. Web app, 14 walkthrough steps | | |
| 4. Terminal demo (25 OK, 26 BLOCKED) | | |
| 5. Amoy deployment | | |
| 5. Amoy demo run | | |
| 6. Web app reading from Amoy | | |
