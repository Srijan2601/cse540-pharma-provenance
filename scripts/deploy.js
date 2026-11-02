// Deploy ProvenanceRegistry and record the deployment for the dApp and the oracle.
//
// Usage:
//   npx hardhat run scripts/deploy.js                     throwaway in-process chain (smoke test; nothing saved)
//   npm run deploy:local                                  needs `npm run node` running in another terminal
//   npm run deploy:amoy                                   needs AMOY_RPC_URL + DEPLOYER_PRIVATE_KEY (see .env.example)
//
// Optional env (public networks only, e.g. amoy):
//   REGULATOR_ADDRESS   wallet that gets REGULATOR_ROLE + DEFAULT_ADMIN_ROLE (default: the deployer)
// On the local networks (default, localhost) it is ignored and the regulator is
// always the deployer (Hardhat account #0). That way an .env filled in for Amoy
// can't break the local demo.
//
// Output: deployments/<network>.json = { address, chainId, deployBlock, txHash, abi, ... }
//   frontend/ and oracle/ read the address + ABI from here; deployBlock is where
//   the verify page starts its event (history) queries.
//   deployments/amoy.json is committed; localhost.json is gitignored.
import { network } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";

const { ethers, networkName } = await network.create();
const isLocal = networkName === "default" || networkName === "localhost";

const [deployer] = await ethers.getSigners();
const envRegulator = process.env.REGULATOR_ADDRESS?.trim();
if (isLocal && envRegulator) {
  console.log(`Note: REGULATOR_ADDRESS is ignored on ${networkName}; the deployer is the regulator.`);
}
const regulator = (!isLocal && envRegulator) || deployer.address;
if (!ethers.isAddress(regulator)) {
  // Don't print the value: people sometimes paste a private key here by mistake.
  throw new Error(
    `REGULATOR_ADDRESS is not a valid address (${regulator.length} characters). Use the wallet ADDRESS, never a private key.`,
  );
}

const { chainId } = await ethers.provider.getNetwork();
console.log(`Network:   ${networkName} (chainId ${chainId})`);
console.log(`Deployer:  ${deployer.address}`);
console.log(`Regulator: ${regulator}${regulator === deployer.address ? " (deployer)" : ""}`);

const registry = await ethers.deployContract("ProvenanceRegistry", [regulator]);
await registry.waitForDeployment();
const receipt = await registry.deploymentTransaction().wait();
const address = await registry.getAddress();

console.log(`ProvenanceRegistry deployed at ${address}`);
console.log(`  tx ${receipt.hash} in block ${receipt.blockNumber}`);

if (networkName === "default") {
  console.log("In-process network: nothing saved. Use --network localhost or --network amoy to record a deployment.");
} else {
  const record = {
    contract: "ProvenanceRegistry",
    network: networkName,
    chainId: Number(chainId),
    address,
    deployBlock: receipt.blockNumber,
    txHash: receipt.hash,
    deployer: deployer.address,
    regulator,
    deployedAt: new Date().toISOString(),
    abi: JSON.parse(registry.interface.formatJson()),
  };
  const dir = new URL("../deployments/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const file = new URL(`${networkName}.json`, dir);
  await writeFile(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`Saved deployments/${networkName}.json`);

  if (networkName === "amoy") {
    console.log(`Explorer: https://amoy.polygonscan.com/address/${address}`);
    console.log("Next: update the Deployments table in README.md, then run `npm run roles:amoy`.");
  } else {
    console.log("Next: `npm run roles:local` to onboard the demo organizations.");
  }
}
