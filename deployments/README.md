# deployments/

Written by [`scripts/deploy.js`](../scripts/deploy.js). One JSON file per network. This is the hand-off point for `frontend/` and `oracle/`: they read the contract **address** and **ABI** from here, and never from Hardhat's gitignored `artifacts/` folder.

| File | Committed? | Created by |
|---|---|---|
| `amoy.json` | **yes**, so everyone uses the same Polygon Amoy deployment | `npm run deploy:amoy` |
| `localhost.json` | no (gitignored; the local chain resets on every restart) | `npm run deploy:local` |

Format:

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

After an Amoy redeploy, commit the new `amoy.json` and update the **Deployments** table in the root README in the same PR.
