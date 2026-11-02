// Onboard the demo organizations: the regulator grants MANUFACTURER, DISTRIBUTOR,
// RETAILER and ORACLE roles (data-flow step 4, "Oversee").
//
// Usage (after scripts/deploy.js has written deployments/<network>.json):
//   npm run roles:local    always uses Hardhat test accounts #1-#4 (any .env values are ignored)
//   npm run roles:amoy     uses the *_ADDRESS values from .env
//
// The account sending the transactions must hold REGULATOR_ROLE. On Amoy that is
// the DEPLOYER_PRIVATE_KEY account, as long as REGULATOR_ADDRESS was left empty
// at deploy time. Locally it is account #0.
//
// Env (public networks only, e.g. amoy):
//   MANUFACTURER_ADDRESS, DISTRIBUTOR_ADDRESS, RETAILER_ADDRESS, ORACLE_ADDRESS
//   REGISTRY_ADDRESS (optional) overrides the address in deployments/<network>.json
//
// Granting is idempotent: accounts that already hold a role are skipped.
import { network } from "hardhat";
import { readFile } from "node:fs/promises";

const { ethers, networkName } = await network.create();
const isLocal = networkName === "default" || networkName === "localhost";
const deployCommand = `npm run deploy:${networkName === "amoy" ? "amoy" : "local"}`;

const ENV_VARS = ["REGISTRY_ADDRESS", "MANUFACTURER_ADDRESS", "DISTRIBUTOR_ADDRESS", "RETAILER_ADDRESS", "ORACLE_ADDRESS"];
if (isLocal && ENV_VARS.some((name) => process.env[name]?.trim())) {
  console.log(`Note: *_ADDRESS / REGISTRY_ADDRESS values from .env are ignored on ${networkName}; using test accounts #1-#4.`);
}
const fromEnv = (name) => (isLocal ? undefined : process.env[name]?.trim() || undefined);

async function registryAddress() {
  const override = fromEnv("REGISTRY_ADDRESS");
  if (override) return override;
  const file = new URL(`../deployments/${networkName}.json`, import.meta.url);
  try {
    return JSON.parse(await readFile(file, "utf8")).address;
  } catch {
    throw new Error(`No deployments/${networkName}.json found. Deploy first (${deployCommand}) or set REGISTRY_ADDRESS.`);
  }
}

const address = await registryAddress();
if (!ethers.isAddress(address)) {
  throw new Error(`Registry address is not a valid address (${String(address).length} characters).`);
}
if ((await ethers.provider.getCode(address)) === "0x") {
  throw new Error(
    `No contract at ${address} on ${networkName}. deployments/${networkName}.json may be stale ` +
      `(was the local node restarted?). Re-run ${deployCommand}.`,
  );
}
const registry = await ethers.getContractAt("ProvenanceRegistry", address);
const [sender, ...testAccounts] = await ethers.getSigners();

const plan = [
  ["MANUFACTURER_ROLE", fromEnv("MANUFACTURER_ADDRESS"), testAccounts[0]],
  ["DISTRIBUTOR_ROLE", fromEnv("DISTRIBUTOR_ADDRESS"), testAccounts[1]],
  ["RETAILER_ROLE", fromEnv("RETAILER_ADDRESS"), testAccounts[2]],
  ["ORACLE_ROLE", fromEnv("ORACLE_ADDRESS"), testAccounts[3]],
];

if (!(await registry.hasRole(await registry.REGULATOR_ROLE(), sender.address))) {
  throw new Error(
    `${sender.address} does not hold REGULATOR_ROLE on ${address}. ` +
      `Run this with the regulator's key (on Amoy: DEPLOYER_PRIVATE_KEY must be the regulator's key).`,
  );
}

console.log(`Registry ${address} on ${networkName}; regulator ${sender.address}`);
for (const [roleName, envAddress, localFallback] of plan) {
  const account = envAddress || (isLocal ? localFallback?.address : undefined);
  if (!account) {
    console.log(`- ${roleName}: skipped (set ${roleName.replace("_ROLE", "")}_ADDRESS in .env)`);
    continue;
  }
  if (!ethers.isAddress(account)) {
    // Don't print the value: people sometimes paste a private key here by mistake.
    throw new Error(
      `${roleName}: the address is not valid (${account.length} characters). Use the wallet ADDRESS, never a private key.`,
    );
  }

  const role = await registry[roleName]();
  if (await registry.hasRole(role, account)) {
    console.log(`- ${roleName}: ${account} already has it`);
    continue;
  }
  const tx = await registry.grantRole(role, account);
  await tx.wait();
  console.log(`- ${roleName}: granted to ${account} (tx ${tx.hash})`);
}
