// Demo: one drug lot travels manufacturer -> distributor -> pharmacy.
//
// Usage:
//   npx hardhat run scripts/demo.js                       in-process chain (deploys its own registry)
//   npx hardhat run scripts/demo.js --network localhost   after `npm run node`, deploy:local, roles:local
// Set PAUSE=1 to wait for Enter between steps (useful while recording).
import { network } from "hardhat";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

const { ethers, networkName } = await network.create();
const STATUS = ["Created", "InTransit", "Stored", "Delivered", "Compromised", "Recalled"];

// Hardhat test accounts #0-#5
const signers = await ethers.getSigners();
if (signers.length < 6) throw new Error("The demo needs 6 accounts: run it on the in-process or localhost network.");
const [regulator, manufacturer, distributor, pharmacy, oracle, outsider] = signers;

const NAMES = new Map([
  [regulator.address, "Regulator"],
  [manufacturer.address, "Manufacturer"],
  [distributor.address, "Distributor"],
  [pharmacy.address, "Pharmacy"],
  [oracle.address, "Oracle"],
  [outsider.address, "Outsider"],
  [ethers.ZeroAddress, "none"],
]);
const who = (address) => NAMES.get(address) ?? address;

// Registry: fresh one in-process, or the one from deployments/<network>.json
let registry;
let deployBlock = 0;
if (networkName === "default") {
  registry = await ethers.deployContract("ProvenanceRegistry", [regulator.address]);
  await registry.waitForDeployment();
  for (const [role, account] of [
    ["MANUFACTURER_ROLE", manufacturer],
    ["DISTRIBUTOR_ROLE", distributor],
    ["RETAILER_ROLE", pharmacy],
    ["ORACLE_ROLE", oracle],
  ]) {
    await (await registry.grantRole(await registry[role](), account.address)).wait();
  }
} else {
  const file = new URL(`../deployments/${networkName}.json`, import.meta.url);
  const record = JSON.parse(await readFile(file, "utf8"));
  registry = await ethers.getContractAt("ProvenanceRegistry", record.address);
  deployBlock = record.deployBlock;
  if (!(await registry.hasRole(await registry.MANUFACTURER_ROLE(), manufacturer.address))) {
    throw new Error("Organizations are not onboarded yet. Run `npm run roles:local` first.");
  }
}

const pause = process.env.PAUSE === "1";
const rl = pause ? createInterface({ input: process.stdin, output: process.stdout }) : null;

async function step(title) {
  if (rl) await rl.question("\n(press Enter) ");
  console.log(`\n=== ${title} ===`);
}

async function send(label, txPromise) {
  const receipt = await (await txPromise).wait();
  console.log(`  OK  ${label}  (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
}

async function expectBlocked(label, txPromise) {
  try {
    await (await txPromise).wait();
    console.log(`  !!  ${label}: was NOT blocked`);
  } catch (err) {
    console.log(`  BLOCKED  ${label}: ${revertName(err)}`);
  }
}

// Name of the custom error a reverted call threw
function revertName(err) {
  if (err?.revert?.name) return err.revert.name;
  for (const data of [err?.data, err?.error?.data, err?.info?.error?.data]) {
    if (typeof data === "string" && data.startsWith("0x")) {
      try {
        const parsed = registry.interface.parseError(data);
        if (parsed) return parsed.name;
      } catch {}
    }
  }
  const match = /custom error '([A-Za-z0-9_]+)/.exec(err?.message ?? "");
  return match ? match[1] : (err?.shortMessage ?? err?.message ?? String(err));
}

async function show(batchId) {
  const b = await registry.verifyBatch(batchId);
  console.log(
    `  lot ${b.id}: status ${STATUS[Number(b.status)]} | custodian ${who(b.custodian)} | pending ${who(b.pendingCustodian)}`,
  );
}

function describe(event) {
  const a = event.args;
  switch (event.name) {
    case "BatchRegistered":
      return `BatchRegistered      by ${who(a.manufacturer)}`;
    case "TransferInitiated":
      return `TransferInitiated    ${who(a.from)} -> ${who(a.to)}`;
    case "CustodyTransferred":
      return `CustodyTransferred   ${who(a.from)} -> ${who(a.to)}`;
    case "StatusUpdated":
      return `StatusUpdated        ${STATUS[Number(a.previousStatus)]} -> ${STATUS[Number(a.newStatus)]} by ${who(a.by)}`;
    default:
      return event.name;
  }
}

// Synthetic lot data (no real product, no personal data)
const productCode = "NDC-0000-0000-00";
const lotNumber = `LOT-${Date.now()}`;
const productHash = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(["string", "string"], [productCode, lotNumber]),
);
const metadataJson = JSON.stringify({ productCode, lotNumber, site: "Demo Plant", expiry: "2027-12-31" });
const metadata = {
  cid: "bafkrei-demo-placeholder",
  contentHash: ethers.keccak256(ethers.toUtf8Bytes(metadataJson)),
};
const manufactureDate = Math.floor(Date.now() / 1000);

console.log(`Network ${networkName}, registry ${await registry.getAddress()}`);

await step("1. Manufacturer registers a new lot (allowed range 2.0-8.0 C)");
console.log(`  product ${productCode}, lot ${lotNumber}`);
await send(
  "registerBatch",
  registry.connect(manufacturer).registerBatch(productHash, manufactureDate, 20, 80, metadata),
);
const batchId = await registry.batchIdOf(productHash);
await show(batchId);

await step("2. An account with no role tries to register a lot");
await expectBlocked(
  "Outsider calls registerBatch",
  registry.connect(outsider).registerBatch(productHash, manufactureDate, 20, 80, metadata),
);

await step("3. Manufacturer starts a hand-off to the Distributor");
await send("initiateTransfer", registry.connect(manufacturer).initiateTransfer(batchId, distributor.address));
await show(batchId);

await step("4. The Pharmacy tries to accept a hand-off meant for the Distributor");
await expectBlocked("Pharmacy calls acceptTransfer", registry.connect(pharmacy).acceptTransfer(batchId));

await step("5. Distributor accepts and becomes the custodian");
await send("acceptTransfer", registry.connect(distributor).acceptTransfer(batchId));
await show(batchId);

await step("6. Distributor hands the lot to the Pharmacy, Pharmacy accepts");
await send("initiateTransfer", registry.connect(distributor).initiateTransfer(batchId, pharmacy.address));
await show(batchId);
await send("acceptTransfer", registry.connect(pharmacy).acceptTransfer(batchId));
await show(batchId);

await step("7. Pharmacy marks the lot Delivered");
await send("markDelivered", registry.connect(pharmacy).markDelivered(batchId));
await show(batchId);

await step("8. Patient view: read-only, no wallet, no role");
const b = await registry.verifyBatch(batchId);
console.log(`  lot ${b.id} (${productCode} / ${lotNumber})`);
console.log(`  status        ${STATUS[Number(b.status)]}`);
console.log(`  manufacturer  ${who(b.manufacturer)}`);
console.log(`  custodian     ${who(b.custodian)}`);
console.log(
  `  temp range    ${(Number(b.minTempTenthsC) / 10).toFixed(1)} to ${(Number(b.maxTempTenthsC) / 10).toFixed(1)} C`,
);
console.log(`  certificate   ${b.certificate.cid ? b.certificate.cid : "not certified yet"}`);
console.log(`  metadata hash ${b.metadata.contentHash}`);

console.log("\n  History, rebuilt from events filtered by lot ID:");
const logs = await ethers.provider.getLogs({
  address: await registry.getAddress(),
  fromBlock: deployBlock,
  toBlock: "latest",
  topics: [null, ethers.toBeHex(batchId, 32)],
});
for (const log of logs) {
  const event = registry.interface.parseLog(log);
  if (event) console.log(`  block ${String(log.blockNumber).padStart(3)}  ${describe(event)}`);
}

rl?.close();
console.log("\nDone.");