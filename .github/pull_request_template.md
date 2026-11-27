## What does this PR do?
<!-- One or two sentences. Link the task/issue: Closes #123 -->

## Area
- [ ] contracts / tests / scripts
- [ ] frontend (dApp, QR verify page)
- [ ] oracle / IPFS
- [ ] docs / analysis / report

## Checklist
- [ ] `npm test` passes locally (CI runs it too)
- [ ] A teammate reviewed this PR
- [ ] **Public-repo safety:** no private keys, `.env` files, API tokens, ASU IDs, emails, or the proposal/team-contract PDF
- [ ] If `contracts/interfaces/IProvenanceRegistry.sol` changed: the team is told; contract README updated; frontend/oracle consumers checked
- [ ] If a contract changed: ran `npm run compile` and included `deployments/abi/ProvenanceRegistry.json`
- [ ] If a contract changed: ran `npm run gas:report` and included `docs/analysis/data/`
- [ ] Nothing under `contracts/` changed except `contracts/README.md`, or the team agreed to redeploy (the registry on Amoy was compiled from these exact sources)
- [ ] If the contract was redeployed to Amoy and the project moves to the new registry: `deployments/amoy.json` and every document that names the old address are updated (list in `deployments/README.md`)
- [ ] If a design question was settled: `docs/design-decisions.md` is updated
