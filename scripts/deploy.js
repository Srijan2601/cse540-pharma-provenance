// Deploy ProvenanceRegistry and record the deployment for the dApp and the oracle.
//
// Usage:
//   npx hardhat run scripts/deploy.js                     throwaway in-process chain (smoke test; nothing saved)
//   npm run deploy:local                                  needs `npm run node` running in another terminal
//   npm run deploy:amoy                                   needs AMOY_RPC_URL + DEPLOYER_PRIVATE_KEY, from the
//                                                         Hardhat keystore or .env (see hardhat.config.js).
//                                                         For AMOY_RPC_URL use https://polygon-amoy-bor-rpc.publicnode.com,
//                                                         not drpc.org: scripts/demo.js explains why.
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
//   (The ABI alone is also committed as deployments/abi/ProvenanceRegistry.json
//   by `npm run compile`, for use before any deployment exists.)
//
// After an Amoy deploy the script prints the command that publishes the source
// code on the block explorer. The constructor argument it needs is the
// regulator address, which is why the command is printed here, where both
// values are known.
import { network } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import { feeOverrides } from "./lib/fees.js";

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

// On a public network the deployment carries explicit EIP-1559 fees read from
// the node; scripts/lib/fees.js explains why the defaults are not used there.
// The local chains keep Hardhat's defaults.
const fees = isLocal ? {} : await feeOverrides(ethers.provider);
const registry = await ethers.deployContract("ProvenanceRegistry", [regulator], fees);
if (!isLocal) {
  // The deployment is broadcast at this point and gets paid for even if the
  // wait below fails, for example on a free endpoint's time-out. With the hash
  // and the address on screen, the team can look the deployment up on the
  // explorer instead of paying for a second one.
  const { hash } = registry.deploymentTransaction();
  console.log(`Sent:      tx ${hash}`);
  console.log(`           creates the registry at ${registry.target}`);
  if (chainId === 80002n) console.log(`           https://amoy.polygonscan.com/tx/${hash}`);
}
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
    // The explorer recompiles the source and compares it with the deployed
    // bytecode, so verify before the contracts or compiler settings change.
    console.log("Verify the source on the explorer (needs ETHERSCAN_API_KEY; run it before changing the contracts):");
    console.log(`  npm run verify:amoy -- ${address} ${regulator}`);
    console.log("Next: commit deployments/amoy.json and update the Deployments table in README.md. Then either");
    console.log("  npx hardhat run scripts/demo.js --network amoy   the whole demo, paid for by this one wallet");
    console.log("  npm run roles:amoy                               onboard real organization wallets (*_ADDRESS)");
  } else {
    console.log("Next: `npm run roles:local` to onboard the demo organizations.");
  }
}
