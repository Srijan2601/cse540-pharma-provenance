# deployments/

The hand-off point between the contract and the code that uses it. `frontend/` and `oracle/` read the contract **ABI** and **address** from here, and never from Hardhat's gitignored `artifacts/` folder.

| File | Committed? | Created by | Contains |
|---|---|---|---|
| `abi/ProvenanceRegistry.json` | **yes** | `npm run compile` (or `npm run abi:export`) | the ABI only |
| `amoy.json` | **yes**, so everyone uses the same Polygon Amoy deployment | `npm run deploy:amoy` | address, deploy block, ABI |
| `localhost.json` | no (gitignored; the local chain resets on every restart) | `npm run deploy:local` | address, deploy block, ABI |

## `abi/ProvenanceRegistry.json`: the ABI, before any deployment

The ABI of `ProvenanceRegistry` as a plain JSON array: every function, event and custom error, including the ones inherited from OpenZeppelin `AccessControl` (`grantRole`, `hasRole`, `AccessControlUnauthorizedAccount`, ...). It exists so that the dApp and the oracle can be built and tested on a fresh clone without any deployment record. Pair it with an address from `<network>.json`, or from your own configuration:

```js
import abi from "../deployments/abi/ProvenanceRegistry.json" with { type: "json" };
const registry = new ethers.Contract(address, abi, providerOrSigner);
```

[`scripts/export-abi.js`](../scripts/export-abi.js) writes the file from the compiled artifact, and `npm run compile` runs it after every compile. The entries keep the compiler's order (by kind, then by name), so a change to the interface appears as a small diff in review.

**The file must be committed together with any contract change that alters the interface.** [`test/tooling/abi-sync.test.js`](../test/tooling/abi-sync.test.js) is part of `npm test` and fails when the committed file differs from the compiled contract; its message lists the entries that differ. To fix it, run `npm run compile` and commit the result.

## `<network>.json`: one deployment

Written by [`scripts/deploy.js`](../scripts/deploy.js), one file per network. Format:

```json
{
  "contract": "ProvenanceRegistry",
  "network": "amoy",
  "chainId": 80002,
  "address": "0x…",
  "deployBlock": 12345678,
  "txHash": "0x…",
  "deployer": "0x…",
  "regulator": "0x…",
  "deployedAt": "2026-11-10T00:00:00.000Z",
  "abi": [ … ]
}
```

`deployBlock` is where event-history queries should start (verify page, analysis scripts).

`abi` describes the same interface as `abi/ProvenanceRegistry.json`, as it was when that deployment was made. If the contract changed afterwards, the two differ until the contract is redeployed; for a deployed registry, the ABI in its own `<network>.json` is the one that matches the code on-chain.

The committed `amoy.json` records the deployment of 2026-11-26 at `0x603E9669D24BFf7c073ECcea36d203A453d49664`. A new Amoy deployment overwrites the file in your working copy. Commit it only if the project moves to the new registry, and then, in the same PR, update every document that names the old address: the badge, the **Deployments** table and the verify links of the root README, [`../docs/amoy-deployment.md`](../docs/amoy-deployment.md), [`../contracts/README.md`](../contracts/README.md), [`../docs/testing/manual-test-plan.md`](../docs/testing/manual-test-plan.md) and this file. A search for the old address finds them all.

## Verifying the source on the Amoy explorer

Verification publishes the Solidity source next to the contract's address on [amoy.polygonscan.com](https://amoy.polygonscan.com), after the explorer has recompiled it and found the same bytecode. Anyone can then read the code behind the registry, and the explorer decodes its transactions, events and custom errors.

1. Get an API key from an [Etherscan](https://etherscan.io) account. One key covers PolygonScan as well. Provide it as `ETHERSCAN_API_KEY`, preferably with `npx hardhat keystore set ETHERSCAN_API_KEY` (or in `.env`). Together with `AMOY_RPC_URL` that is all verification needs: it sends no transaction and runs on the key-less `amoyVerify` network from `hardhat.config.js`, so any teammate can verify without the deployer's private key.
2. Run the command that `npm run deploy:amoy` printed. It has this form, with the two values from `amoy.json`:

   ```bash
   npm run verify:amoy -- <address> <regulator>
   ```

   `<regulator>` is the constructor argument of the deployment. The explorer needs it to reproduce the deployment transaction.

Things to know:

* **Verify before the contracts change.** The task first matches the deployed bytecode against the local build, then sends the sources. If `contracts/` or the compiler settings have changed since the deploy, check out the commit that was deployed and run `npx hardhat compile` first.
* **The build profile matters.** `verify:amoy` passes `--build-profile default`, because `deploy:amoy` deploys what the default profile compiled. The reason is explained in the `verify` section of [`hardhat.config.js`](../hardhat.config.js). Keep the flag, and `--network amoyVerify`, when you run `npx hardhat verify` by hand.
* The command targets PolygonScan only (`hardhat verify etherscan`). It is safe to repeat: a contract that is already verified is reported as such.
* Local networks (`localhost`, the in-process network) cannot be verified. There is no explorer for them.
