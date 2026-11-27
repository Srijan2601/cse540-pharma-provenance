# Polygon Amoy deployment record

The registry's deployment on the Polygon Amoy testnet: what is deployed, what was run there, what it cost, and practical notes for repeating it. The step-by-step procedure is in the [root README](../README.md#polygon-amoy), and source verification is explained in [`deployments/README.md`](../deployments/README.md#verifying-the-source-on-the-amoy-explorer).

## The deployment

| Field | Value |
|---|---|
| Network | Polygon Amoy testnet, chain ID 80002 |
| Contract | `ProvenanceRegistry` |
| Address | [`0x603E9669D24BFf7c073ECcea36d203A453d49664`](https://amoy.polygonscan.com/address/0x603E9669D24BFf7c073ECcea36d203A453d49664) |
| Deployment transaction | [`0x6407c412ddbd2143e50160b6ae3f353a6fdf8e5dca209174395e3dc40432ea6b`](https://amoy.polygonscan.com/tx/0x6407c412ddbd2143e50160b6ae3f353a6fdf8e5dca209174395e3dc40432ea6b) |
| Deploy block | [53923451](https://amoy.polygonscan.com/block/53923451) |
| Time | 2026-11-27 02:23 UTC, which is 2026-11-26 19:23 in Arizona (UTC−7) |
| Deployer and regulator | [`0xc9B224DFbE539BA65b92d0f7A1cAb102AE42FB90`](https://amoy.polygonscan.com/address/0xc9B224DFbE539BA65b92d0f7A1cAb102AE42FB90), one testnet wallet used for nothing else |
| Compiler | solc 0.8.34, EVM target `cancun`, optimizer on with 200 runs (`hardhat.config.js`) |
| Deployed bytecode | 8,238 bytes |
| Source | `contracts/` and `hardhat.config.js` as of commit `7324e6b`, unchanged on `main` since. The runtime code on chain equals a build of `main`, metadata hash included (compared with `eth_getCode` on 2026-11-26). |
| Record in the repository | [`deployments/amoy.json`](../deployments/amoy.json): address, deploy block, transaction hash and ABI, read by the web app and the oracle |

## What was run

On 2026-11-26 (Arizona time), from Fedora Linux, with a new wallet funded with 1 POL from the faucet:

1. `npm run deploy:amoy` deployed the registry.
2. One run of `npm run demo:amoy` followed, in single-wallet mode. It sent 29 transactions: the 25 registry calls of the local demo, plus 4 transfers that top up the derived wallets of the manufacturer, the distributor, the pharmacy and the oracle. The 26 calls that the contract must refuse were simulated and never sent. The steps are the 19 steps of `npm run demo`.
3. The verify page was opened once against the deployment (`#/verify?lot=1&chain=80002&registry=0x603E…`). The lot's record and history loaded through the default keyless endpoint. The files showed as not fetched, because the terminal demo keeps its documents in memory and uploads them nowhere.

The registry now holds two lots. Lot 1 is Delivered and certified, with 2 sensor logs. Lot 2 is Recalled after a reported excursion, with 2 sensor logs. A read-only call to the public endpoint confirms this state (`totalBatches()` is 2).

Before the real run, on 2026-11-25, the same steps and `npm run roles:amoy` were rehearsed against a local stand-in: a Hardhat node that was given Amoy's chain ID, 80002.

Not run on the real network: `npm run roles:amoy`, `npm run verify:amoy`, the dashboards, the oracle program and the file service. The local system itself was checked on macOS with Node.js 22.18 and, on 2026-11-25, on Fedora Linux with Node.js 22.23.1.

## Cost

All figures are from the receipts of the run of 2026-11-26.

| Item | Gas | Gas price | Cost |
|---|---:|---:|---:|
| Deployment | 2,011,844 | 56 gwei | 0.112663 POL |
| Demo run: 25 registry calls | 2,224,953 | about 59.68 gwei | 0.132787 POL |
| Demo run: 4 top-up transfers | 84,000 | about 59.68 gwei | 0.005013 POL |
| Demo run, total of its 29 transactions | 2,308,953 | base fee 30 gwei plus a priority fee of about 29.7 gwei | 0.137801 POL |

* Step 0 of the demo also moves POL to the derived wallets. What they do not spend stays there for the next run, and nothing sends it back.
* The first run does not start with less than about 0.25 POL in the wallet. Plan on at least 0.4 POL for the deployment and one run; 0.5 POL or more leaves room for a second run.
* Refused calls are simulated with `eth_call`, so they cost nothing.

### Gas on Amoy compared with the Hardhat network

The rehearsal on the local stand-in reported 1,920,885 gas for the same demo run, against 2,308,953 on Amoy. The receipts show the difference call by call. The right-hand column is the same call in `npm run demo` on Hardhat's in-process network; those numbers are within a few gas of [`analysis/data/gas-report.md`](analysis/data/gas-report.md).

| Call | Gas on Amoy (receipt) | Gas on the Hardhat network |
|---|---:|---:|
| Deployment | 2,011,844 | 1,991,684 |
| `grantRole` | 61,564 | 51,484 |
| `registerBatch`, first lot | 303,415 | 275,695 |
| `registerBatch`, second lot | 285,475 | 258,595 |
| `issueCertificate`, first certificate | 139,024 | 123,064 |
| `initiateTransfer`, manufacturer to distributor | 60,427 | 41,107 |
| `initiateTransfer`, distributor to pharmacy | 92,067 | 66,027 |
| `cancelTransfer` | 53,912 | 37,952 |
| `acceptTransfer`, distributor | 50,425 | 38,665 |
| `acceptTransfer`, pharmacy | 56,089 | 40,969 |
| `updateStatus` | 49,080 | 36,480 |
| `markDelivered` | 48,431 | 35,831 |
| `anchorSensorLog`, first log of a lot | 141,665 | 126,545 |
| `anchorSensorLog`, later log | 67,992 | 55,392 |
| `reportExcursion` | 69,848 | 57,248 |
| `recallBatch` | 45,176 | 35,936 |
| All 25 registry calls of the demo | 2,224,953 | 1,836,849 |

Every call used more gas on Amoy, by 9,240 to 27,720 gas, and the 25 calls together used 21% more. This repository does not analyse the cause. For costs on Amoy, quote the receipts on PolygonScan, not the local figures; design decision **D5** in [`design-decisions.md`](design-decisions.md) records the same point.

## Faucet

<https://faucet.polygon.technology> worked on 2026-11-26. It asks you to sign in with GitHub or X, and the POL arrived within a few minutes. Faucets that ask for a balance on a real network can be skipped. Test POL is free: never buy it, and never type a seed phrase into a faucet page.

## RPC endpoint

Use `https://polygon-amoy-bor-rpc.publicnode.com`. It needs no key, and it is the default of the web app and the oracle.

| Endpoint | Result of a test on 2026-11-25 |
|---|---|
| `polygon-amoy-bor-rpc.publicnode.com` | Answered 40 of 40 requests and accepted event queries of up to 10,000 blocks. |
| `polygon-amoy.drpc.org` | Answered 31 of 40 requests and refused every event query over 100 blocks. |
| `rpc-amoy.polygon.technology` | Shut down: its name no longer resolved. The midterm README had named this endpoint. |

The endpoint matters because the scripts do not retry a failed request, and because the history query of the demo's last step and of the verify page spans many blocks.

## Onboarding real organization wallets

`npm run demo:amoy` plays every organization from one wallet. To give the roles to real wallets instead, put their addresses in `MANUFACTURER_ADDRESS`, `DISTRIBUTOR_ADDRESS`, `RETAILER_ADDRESS` and `ORACLE_ADDRESS` and run `npm run roles:amoy` as the regulator. The variables are listed under [Configuration](../README.md#configuration) in the root README.
