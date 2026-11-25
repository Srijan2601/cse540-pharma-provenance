// Demo: two drug lots on the registry, with every role taking its turn.
//
//   Lot A  travels manufacturer -> distributor -> pharmacy. On the way the
//          regulator certifies it, a hand-off to the wrong organization is
//          cancelled, the oracle anchors sensor logs, the distributor moves
//          it between its sites, and the pharmacy marks it Delivered.
//   Lot B  is the cold-chain failure: the oracle reports a temperature
//          excursion while the lot is on its way to the pharmacy, the lot
//          becomes Compromised, and the regulator recalls it.
//
// Between the successful calls the script tries calls that the contract must
// refuse (wrong role, not the custodian, invalid data) and prints the custom
// error each one reverts with. These calls are simulated with eth_call and
// never broadcast, so a refusal costs no gas. The last step is the patient's
// view: the lot record and its history, read with no wallet.
//
// Usage:
//   npx hardhat run scripts/demo.js                       in-process chain (deploys its own registry)
//   npx hardhat run scripts/demo.js --network localhost   after `npm run node`, deploy:local, roles:local
//   npx hardhat run scripts/demo.js --network amoy        Polygon Amoy testnet, after `npm run deploy:amoy`
// or the shortcuts `npm run demo` and `npm run demo:local`.
// Set PAUSE=1 to wait for Enter between steps (useful while recording).
//
// On localhost the demo uses the registry from deployments/localhost.json and
// can be repeated on the same chain: every run registers two new lots. Step 1
// onboards any demo organization that is not onboarded yet. `npm run
// roles:local` covers four of them; the second distributor (test account #6)
// is onboarded by the first demo run.
//
// On Polygon Amoy the demo runs in single-wallet mode. A public network gives
// the script the one account that was configured for it (DEPLOYER_PRIVATE_KEY),
// not the seven the demo has actors for. The script notices that and then:
//   * uses that account as the Regulator. It must be the account that deployed
//     the registry in deployments/amoy.json, which makes it the regulator;
//   * derives the other six actors from it as throwaway wallets, the same ones
//     on every run, with no key stored anywhere (scripts/lib/single-wallet.js);
//   * in an extra step 0, prints what the run will cost and tops each wallet
//     up with what it still lacks for its steps. If the account cannot cover
//     the run, the script stops there, before anything is sent;
//   * sends every transaction with explicit fees, read from the node once in
//     step 0 (scripts/lib/fees.js), and prints its block-explorer link;
//   * lists the transactions of the run once more at the end, for the report.
// One-time setup, with no .env file and no API key:
//   npx hardhat keystore set AMOY_RPC_URL           https://polygon-amoy-bor-rpc.publicnode.com
//   npx hardhat keystore set DEPLOYER_PRIVATE_KEY   the team's wallet holding test POL
//   npm run deploy:amoy
// The endpoint matters. Of the two key-less ones tried on 2026-11-25,
// publicnode.com answered every request. polygon-amoy.drpc.org failed some
// requests, and a failed request stops the script. Its free plan also refuses
// event queries over more than 100 blocks, and the history query of step 19
// spans the whole run, which at Amoy's pace of one block per second is likely
// to be more than 100 blocks.
//
// Cost. Gas does not depend on the network: the deployment is about 2.0
// million gas, a first demo run about 1.9 million and a later run about 1.6
// million. What that costs in POL depends on the gas price at the time. On
// 2026-11-25 Amoy's suggested price was about 41 gwei and, later that day,
// about 54 gwei, which puts the deployment and two runs at about 0.26 to 0.34
// POL. The "Polygon Amoy" section of the root README gives the figures at
// both prices and suggests funding the wallet with 0.5 POL. Step 0 tops each
// wallet up to what its steps need plus a quarter, so every later run tops up
// again about what the run before used: at those prices a later run needs
// about 0.07 to 0.09 POL to start. About 0.03 to 0.04 POL stays in the
// derived wallets after the last run, and nothing sends it back, so count it
// as spent.
//
// Output markers: "OK" a transaction that succeeded, "BLOCKED" a call that
// reverted as intended, "--" nothing to do. A line marked "!!" means the
// contract or this script misbehaved; the script then exits with code 1.
import { network } from "hardhat";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { DocumentStore, lotMetadata, regulatorCertificate, sensorLog } from "./lib/demo-documents.js";
import { currentFees, sendWithFees } from "./lib/fees.js";
import { deriveDemoWallets, highestReportedGas } from "./lib/single-wallet.js";

const { ethers, networkName } = await network.create();
const { chainId } = await ethers.provider.getNetwork();
const STATUS = ["Created", "InTransit", "Stored", "Delivered", "Compromised", "Recalled"];
const statusId = (name) => STATUS.indexOf(name);

// A precondition of the run is not met: print what to do and end the script
// with exit code 1. Every caller runs before anything is sent. Thrown as an
// error, the same text would arrive wrapped in Hardhat's "unexpected error"
// report with a stack trace, as if the script were broken.
function stop(message) {
  console.error(message);
  process.exit(1);
}

// Hardhat test accounts #0-#6. Account #5 never gets a role. Account #6 is a
// second distributor: the organization that a hand-off is sent to by mistake,
// and a rival that must not be able to touch another distributor's lot.
//
// A network that provides fewer accounts than the demo has actors puts the
// script in single-wallet mode (see the header): its first account is the
// regulator, and the other six actors are wallets derived from that account.
const signers = await ethers.getSigners();
if (signers.length === 0) stop(`The network ${networkName} provides no account to send from.`);
const singleWallet = signers.length < 7;
const [regulator, manufacturer, distributor, pharmacy, oracle, outsider, distributorB] = singleWallet
  ? [
      signers[0],
      ...(await deriveDemoWallets(signers[0], [
        "manufacturer",
        "distributor",
        "pharmacy",
        "oracle",
        "outsider",
        "distributor-b",
      ])),
    ]
  : signers;

// What depends on the chain: Amoy has a block explorer, and its coin is POL.
const onAmoy = chainId === 80002n;
const explorer = onAmoy ? "https://amoy.polygonscan.com" : null;
const coin = onAmoy ? "POL" : "ETH";

// Blocks to wait for after sending a transaction. One is enough on a local
// chain. A public chain is reached through load-balanced RPC endpoints, where
// the server that answers the next request may not have the receipt's block
// yet and would run the next step on the state before it; a second block makes
// that unlikely. A local development chain (chain id 31337) cannot wait for
// two: it mines a block only when a transaction arrives.
const confirmations = singleWallet && chainId !== 31337n ? 2 : 1;

const NAMES = new Map([
  [regulator.address, "Regulator"],
  [manufacturer.address, "Manufacturer"],
  [distributor.address, "Distributor"],
  [distributorB.address, "Distributor B"],
  [pharmacy.address, "Pharmacy"],
  [oracle.address, "Oracle"],
  [outsider.address, "Outsider"],
  [ethers.ZeroAddress, "none"],
]);
const who = (address) => NAMES.get(address) ?? address;

// The organizations the regulator onboards in step 1 (proposal Table I).
const ORGANIZATIONS = [
  ["MANUFACTURER_ROLE", manufacturer],
  ["DISTRIBUTOR_ROLE", distributor],
  ["DISTRIBUTOR_ROLE", distributorB],
  ["RETAILER_ROLE", pharmacy],
  ["ORACLE_ROLE", oracle],
];

// Registry: fresh one in-process, or the one from deployments/<network>.json
let registry;
let deployBlock = 0;
if (networkName === "default") {
  registry = await ethers.deployContract("ProvenanceRegistry", [regulator.address]);
  await registry.waitForDeployment();
} else {
  // The command that deploys a registry on this network, for the messages below.
  const deployCommand =
    { localhost: "npm run deploy:local", amoy: "npm run deploy:amoy" }[networkName] ??
    `npx hardhat run scripts/deploy.js --network ${networkName}`;
  const file = new URL(`../deployments/${networkName}.json`, import.meta.url);
  let record;
  try {
    record = JSON.parse(await readFile(file, "utf8"));
  } catch {
    stop(`No deployments/${networkName}.json found. Run \`${deployCommand}\` first.`);
  }
  if ((await ethers.provider.getCode(record.address)) === "0x") {
    stop(
      `No contract at ${record.address} on ${networkName}. deployments/${networkName}.json is stale` +
        `${networkName === "localhost" ? " (was the local node restarted?)" : ""}. Re-run \`${deployCommand}\`.`,
    );
  }
  registry = await ethers.getContractAt("ProvenanceRegistry", record.address);
  deployBlock = record.deployBlock;
  // Step 1 grants whatever `npm run roles:local` has not granted yet, which
  // only the regulator can do. deploy.js makes account #0 the regulator on
  // local networks, and the deploying account on a public one unless
  // REGULATOR_ADDRESS names another wallet.
  if (!(await registry.hasRole(await registry.REGULATOR_ROLE(), regulator.address))) {
    stop(
      singleWallet
        ? `${regulator.address}, the account of the network ${networkName}, does not hold REGULATOR_ROLE on the ` +
            `registry ${record.address} from deployments/${networkName}.json. In single-wallet mode that account ` +
            "must be the regulator. Deploy a registry with it first, leaving REGULATOR_ADDRESS unset: " +
            `\`${deployCommand}\``
        : `Account #0 is not the regulator of ${record.address}. Re-run \`${deployCommand}\`.`,
    );
  }
}
const registryAddress = await registry.getAddress();

// Where the history queries of the last step start. Locally that is the
// registry's deployment block, as on the verify page. A public RPC endpoint
// refuses an event query over that many blocks (publicnode.com: 10,000 at
// most, under three hours of Amoy), so single-wallet mode starts at the block
// this run began in. Both lots are registered after it.
const historyFromBlock = singleWallet ? await ethers.provider.getBlockNumber() : deployBlock;

const pause = process.env.PAUSE === "1";
const rl = pause ? createInterface({ input: process.stdin, output: process.stdout }) : null;

// Number of "!!" lines printed. Any at all makes the script exit with code 1,
// so the demo doubles as an end-to-end smoke test.
let problems = 0;

// Single-wallet mode keeps what it sent, with the step it belongs to, for the
// list at the end of the run.
const sent = [];
let currentStep;
const transactionReference = (hash) => (explorer ? `${explorer}/tx/${hash}` : `tx ${hash}`);

async function step(title) {
  if (rl) await rl.question("\n(press Enter) ");
  console.log(`\n=== ${title} ===`);
  currentStep = title;
}

async function send(label, txPromise) {
  const receipt = await (await txPromise).wait(confirmations);
  console.log(`  OK  ${label}  (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  if (singleWallet) {
    console.log(`      ${transactionReference(receipt.hash)}`);
    sent.push({ step: currentStep, label, receipt });
  }
}

// A call that the contract must refuse. `expected` is the custom error the
// demo is showing at this point. A call that goes through, or that reverts
// for a different reason, is reported as a problem.
//
// `call` is a simulation: `contract.method.staticCall(...)` for a function
// that changes state, or a plain view call. The node executes it with eth_call
// and nothing is broadcast. A refusal therefore costs no gas, an account with
// no balance can make the attempt, and a call that the contract wrongly lets
// through is reported without having changed the chain.
async function expectBlocked(label, call, expected) {
  try {
    await call;
    console.log(`  !!  ${label}: was NOT blocked`);
    problems += 1;
  } catch (err) {
    const name = revertName(err);
    if (expected === undefined || name === expected) {
      console.log(`  BLOCKED  ${label}: ${name}`);
    } else {
      console.log(`  !!  ${label}: blocked by ${name}, expected ${expected}`);
      problems += 1;
    }
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

const celsius = (tenths) => (Number(tenths) / 10).toFixed(1);
const isoTime = (unixSeconds) => new Date(Number(unixSeconds) * 1000).toISOString();
// A CID is 59 characters; the history lines show its two ends.
const shortCid = (cid) => `${cid.slice(0, 12)}...${cid.slice(-6)}`;

function describe(event) {
  const a = event.args;
  switch (event.name) {
    case "BatchRegistered":
      return `BatchRegistered      by ${who(a.manufacturer)}, metadata ${shortCid(a.metadataCid)}`;
    case "TransferInitiated":
      return `TransferInitiated    ${who(a.from)} -> ${who(a.to)}`;
    case "CustodyTransferred":
      return `CustodyTransferred   ${who(a.from)} -> ${who(a.to)}`;
    case "TransferCancelled":
      return `TransferCancelled    ${who(a.from)} withdrew the hand-off to ${who(a.to)}`;
    case "StatusUpdated":
      return `StatusUpdated        ${STATUS[Number(a.previousStatus)]} -> ${STATUS[Number(a.newStatus)]} by ${who(a.by)}`;
    case "CertificateIssued":
      return `CertificateIssued    by ${who(a.regulator)}, file ${shortCid(a.cid)}`;
    case "SensorLogAnchored":
      return `SensorLogAnchored    log #${a.logIndex}, file ${shortCid(a.cid)}`;
    case "ExcursionReported":
      return `ExcursionReported    log #${a.logIndex}: ${celsius(a.readingTenthsC)} C at ${isoTime(a.observedAt)}, file ${shortCid(a.logCid)}`;
    case "BatchRecalled":
      return `BatchRecalled        by ${who(a.regulator)}: "${a.reason}"`;
    default:
      return event.name;
  }
}

// Off-chain documents. `documents` stands in for IPFS: add() "pins" a file and
// returns the { cid, contentHash } pair that goes on-chain; get() "downloads"
// it again for the patient's hash check in the last step.
const documents = new DocumentStore();
// Every document names the chain and the registry it belongs to, so it cannot
// be passed off as a document of another deployment.
const deployment = { chainId: Number(chainId), registry: registryAddress };

// The chain's clock, not this machine's. The contract rejects a manufacture
// date or a sensor reading time that is later than the block timestamp, and a
// local chain's clock can differ from the wall clock, as a laptop's can from
// a public chain's.
//
// In single-wallet mode the time is taken half a minute back. A reading time
// equal to the latest block's timestamp is valid only from that block on, and
// a load-balanced RPC endpoint may simulate the call on a server that is still
// a block behind, where the same time lies in the future.
const CLOCK_SLACK_SECONDS = singleWallet ? 30 : 0;
const chainTime = async () => (await ethers.provider.getBlock("latest")).timestamp - CLOCK_SLACK_SECONDS;

// The verify page checks a file against the chain like this (data flow 5):
// fetch the bytes by the on-chain CID, hash them, compare with the on-chain hash.
function checkFile(reference) {
  const bytes = documents.get(reference.cid);
  if (bytes !== undefined && ethers.keccak256(bytes) === reference.contentHash) {
    console.log("                file matches the on-chain hash");
  } else {
    const what = bytes === undefined ? "no file found for" : "the file does NOT match the on-chain hash of";
    console.log(`  !!  ${what} ${reference.cid}`);
    problems += 1;
  }
}

// The record and history of one lot, as the verify page shows them. `reader`
// is connected to a provider only: no signer, no account, no role.
const reader = registry.connect(ethers.provider);
async function patientView(batchId, lotNumber) {
  const b = await reader.verifyBatch(batchId);
  console.log(`\n  lot ${b.id} (${productCode} / ${lotNumber})`);
  console.log(`  status        ${STATUS[Number(b.status)]}`);
  console.log(`  manufacturer  ${who(b.manufacturer)}`);
  console.log(`  custodian     ${who(b.custodian)}`);
  console.log(`  temp range    ${celsius(b.minTempTenthsC)} to ${celsius(b.maxTempTenthsC)} C`);
  console.log(`  certificate   ${b.certificate.cid ? b.certificate.cid : "not certified yet"}`);
  if (b.certificate.cid) checkFile(b.certificate);
  console.log(`  sensor logs   ${b.sensorLogCount} anchored`);
  if (b.sensorLogCount > 0n) {
    console.log(`  latest log    ${b.latestSensorLog.cid}`);
    checkFile(b.latestSensorLog);
  }
  console.log(`  metadata      ${b.metadata.cid}`);
  checkFile(b.metadata);
  console.log(`  metadata hash ${b.metadata.contentHash}`);

  // Every registry event has the lot ID as its first indexed topic, so one
  // topic filter returns the whole history of a lot and nothing else.
  console.log("\n  History, rebuilt from events filtered by lot ID:");
  let logs;
  try {
    logs = await ethers.provider.getLogs({
      address: registryAddress,
      fromBlock: historyFromBlock,
      toBlock: "latest",
      topics: [null, ethers.toBeHex(batchId, 32)],
    });
  } catch (err) {
    // Some free RPC endpoints time out on event queries. The transactions of
    // the run are already on the chain at this point, so report the failure
    // and carry on to the end of the script instead of stopping here.
    console.log(`  !!  the node did not answer the event query (eth_getLogs): ${err.shortMessage ?? err.message}`);
    problems += 1;
    return;
  }
  for (const log of logs) {
    const event = registry.interface.parseLog(log);
    if (event) console.log(`  block ${String(log.blockNumber).padStart(3)}  ${describe(event)}`);
  }
}

// Synthetic lot data (no real product, no personal data). The lot numbers
// contain the start time of this run, so the demo can be repeated on the
// same registry, local or on Amoy, without hitting DuplicateProduct.
const productCode = "NDC-0000-0000-00";
const runId = Date.now();
const productHashOf = (lot) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "string"], [productCode, lot]));
const lotNumber = `LOT-${runId}-A`;
const productHash = productHashOf(lotNumber);
const lotNumberB = `LOT-${runId}-B`;
const productHashB = productHashOf(lotNumberB);

const range = { minTempTenthsC: 20, maxTempTenthsC: 80 };
const manufactureDate = (await chainTime()) - 24 * 60 * 60; // made yesterday
const metadata = documents.add(lotMetadata({ ...deployment, productCode, lotNumber, manufactureDate, ...range }));
const metadataB = documents.add(
  lotMetadata({ ...deployment, productCode, lotNumber: lotNumberB, manufactureDate, ...range }),
);

// Single-wallet mode, step 0: what the run will cost, and the top-ups.
//
// How often each derived wallet calls which function in steps 2 to 18. Keep
// the table in step with those steps: a wallet is funded for exactly these
// calls. Distributor B and the Outsider are missing because they send
// nothing; they only receive a hand-off or appear in simulated calls.
const WALLET_CALLS = [
  [manufacturer, { registerBatch: 2, initiateTransfer: 3, cancelTransfer: 1 }],
  [distributor, { acceptTransfer: 2, updateStatus: 2, initiateTransfer: 2 }],
  [pharmacy, { acceptTransfer: 1, markDelivered: 1 }],
  [oracle, { anchorSensorLog: 3, reportExcursion: 1 }],
];
// The regulator's calls. It also sends one grantRole per organization that is
// not onboarded yet (step 1) and one transfer per top-up (step 0).
const REGULATOR_CALLS = { issueCertificate: 1, recallBatch: 1 };
const TRANSFER_GAS = 21_000n; // a plain transfer to an account that has no code

// Amounts of the chain's coin and prices per gas, as step 0 and the list at
// the end print them. Six decimals show a single top-up at Amoy's fees.
const coins = (wei) => `${Number(ethers.formatEther(wei)).toFixed(6)} ${coin}`;
const gwei = (wei) => `${ethers.formatUnits(wei, "gwei")} gwei`;

// Takes the fees that every transaction of this run carries (see step 0 below).
async function fundDemoWallets({ baseFeePerGas, maxPriorityFeePerGas, maxFeePerGas }) {
  const gasOf = await highestReportedGas();
  const gasFor = (calls) => Object.entries(calls).reduce((gas, [name, count]) => gas + BigInt(count) * gasOf(name), 0n);
  const balanceOf = (account) => ethers.provider.getBalance(account.address);
  // What an account must hold to send transactions of `gas` in total. A node
  // only accepts a transaction whose sender can pay gas x maxFeePerGas, even
  // though less is charged. The extra quarter covers a gas figure that turns
  // out higher than the report's.
  const reserveFor = (gas) => (gas * maxFeePerGas * 5n) / 4n;

  for (const account of [regulator, manufacturer, distributor, distributorB, pharmacy, oracle, outsider]) {
    console.log(`  ${who(account.address).padEnd(13)} ${account.address}  holds ${coins(await balanceOf(account))}`);
  }

  // What each wallet still lacks for its calls, and the gas of the whole run.
  let runGas = 0n;
  const topUps = [];
  for (const [wallet, calls] of WALLET_CALLS) {
    const gas = gasFor(calls);
    const missing = reserveFor(gas) - (await balanceOf(wallet));
    topUps.push([wallet, missing > 0n ? missing : 0n]);
    runGas += gas;
  }
  const topUpTotal = topUps.reduce((sum, [, amount]) => sum + amount, 0n);
  const transfers = topUps.filter(([, amount]) => amount > 0n).length;
  let rolesToGrant = 0;
  for (const [roleName, account] of ORGANIZATIONS) {
    if (!(await registry.hasRole(await registry[roleName](), account.address))) rolesToGrant += 1;
  }
  const regulatorGas = gasFor({ ...REGULATOR_CALLS, grantRole: rolesToGrant }) + TRANSFER_GAS * BigInt(transfers);
  runGas += regulatorGas;

  const price = baseFeePerGas + maxPriorityFeePerGas;
  console.log(`  Fees now: base fee ${gwei(baseFeePerGas)} + priority fee ${gwei(maxPriorityFeePerGas)}.`);
  console.log(`  Estimated cost of this run: up to ${coins(runGas * price)} (${runGas} gas at ${gwei(price)}).`);

  const needed = topUpTotal + reserveFor(regulatorGas);
  const held = await balanceOf(regulator);
  console.log(`  To start it the Regulator's account must hold ${coins(needed)}, a 25% reserve included:`);
  const ownShare = coins(needed - topUpTotal);
  console.log(`  ${coins(topUpTotal)} to top up the other wallets, ${ownShare} for its own transactions.`);
  if (held < needed) {
    stop(
      `The Regulator's account ${regulator.address} holds ${coins(held)}, but this run needs ${coins(needed)}. ` +
        `Nothing was sent. Send about ${coins(needed - held)} more to that address and run the demo again.`,
    );
  }

  for (const [wallet, amount] of topUps) {
    if (amount === 0n) {
      console.log(`  --  ${who(wallet.address)} already holds enough for its steps`);
    } else {
      await send(
        `top up ${who(wallet.address)} with ${coins(amount)}`,
        regulator.sendTransaction({ to: wallet.address, value: amount }),
      );
    }
  }
}

console.log(`Network ${networkName}, registry ${registryAddress}`);
console.log("Document CIDs below are real CIDv1 values computed from synthetic JSON files, but the files");
console.log("are NOT pinned to IPFS in this contract-level demo: their bytes stay in this script's memory.");

if (singleWallet) {
  await step("0. Single-wallet mode: the Regulator's account pays for the other actors");
  // Local test accounts keep the libraries' default fees; scripts/lib/fees.js
  // explains why a public network needs explicit ones. They are read once,
  // here, and every transaction of the run carries exactly these values, the
  // top-ups below included. The top-ups are sized at the same values, so no
  // wallet runs short half-way: the priority fee that Amoy's endpoints quote
  // was seen on 2026-11-25 to move between 30 and 41.25 gwei from one request
  // to the next.
  // Whatever value is read is one the network accepts, and the cap of twice
  // the base fee stays above Amoy's base fee, a few wei, for the whole run.
  const fees = await currentFees(ethers.provider);
  for (const signer of [regulator, manufacturer, distributor, pharmacy, oracle]) sendWithFees(signer, fees);
  await fundDemoWallets(fees);
}

await step("1. Regulator onboards the organizations (grantRole)");
for (const [roleName, account] of ORGANIZATIONS) {
  const role = await registry[roleName]();
  if (await registry.hasRole(role, account.address)) {
    console.log(`  --  ${who(account.address)} already holds ${roleName}`);
  } else {
    await send(
      `grantRole ${roleName} to ${who(account.address)}`,
      registry.connect(regulator).grantRole(role, account.address),
    );
  }
}
await expectBlocked(
  "Manufacturer tries to grant itself DISTRIBUTOR_ROLE",
  registry.connect(manufacturer).grantRole.staticCall(await registry.DISTRIBUTOR_ROLE(), manufacturer.address),
  "AccessControlUnauthorizedAccount",
);

console.log("\n----- Lot A: from the factory to the pharmacy -----");

await step("2. Manufacturer registers a new lot (allowed range 2.0-8.0 C)");
console.log(`  product ${productCode}, lot ${lotNumber}`);
console.log(`  metadata file ${metadata.cid}`);
await send(
  "registerBatch",
  registry.connect(manufacturer).registerBatch(productHash, manufactureDate, 20, 80, metadata),
);
const batchId = await registry.batchIdOf(productHash);
await show(batchId);

await step("3. An account with no role tries to register a lot");
await expectBlocked(
  "Outsider calls registerBatch",
  registry.connect(outsider).registerBatch.staticCall(productHash, manufactureDate, 20, 80, metadata),
  "AccessControlUnauthorizedAccount",
);

await step("4. The Manufacturer's own invalid registrations are rejected too");
// Each call breaks exactly one rule; everything else about it is valid.
await expectBlocked(
  "the same product code and lot number again",
  registry.connect(manufacturer).registerBatch.staticCall(productHash, manufactureDate, 20, 80, metadata),
  "DuplicateProduct",
);
await expectBlocked(
  "a product hash that was never computed (zero)",
  registry.connect(manufacturer).registerBatch.staticCall(ethers.ZeroHash, manufactureDate, 20, 80, metadataB),
  "ZeroProductHash",
);
await expectBlocked(
  "a temperature range of 8.0 to 2.0 C (minimum above maximum)",
  registry.connect(manufacturer).registerBatch.staticCall(productHashB, manufactureDate, 80, 20, metadataB),
  "InvalidTemperatureRange",
);
const nextYear = (await chainTime()) + 365 * 24 * 60 * 60;
await expectBlocked(
  "a manufacture date one year in the future",
  registry.connect(manufacturer).registerBatch.staticCall(productHashB, nextYear, 20, 80, metadataB),
  "InvalidTimestamp",
);
const unhashedMetadata = { cid: metadataB.cid, contentHash: ethers.ZeroHash };
await expectBlocked(
  "a metadata file with no content hash",
  registry.connect(manufacturer).registerBatch.staticCall(productHashB, manufactureDate, 20, 80, unhashedMetadata),
  "EmptyDocument",
);

await step("5. Regulator certifies the lot (issueCertificate)");
const certificate = documents.add(
  regulatorCertificate({ ...deployment, lotId: Number(batchId), productHash, issuedAt: await chainTime() }),
);
console.log(`  certificate file ${certificate.cid}`);
await expectBlocked(
  "Outsider calls issueCertificate",
  registry.connect(outsider).issueCertificate.staticCall(batchId, certificate),
  "AccessControlUnauthorizedAccount",
);
await expectBlocked(
  "Manufacturer tries to certify its own lot",
  registry.connect(manufacturer).issueCertificate.staticCall(batchId, certificate),
  "AccessControlUnauthorizedAccount",
);
await send("issueCertificate", registry.connect(regulator).issueCertificate(batchId, certificate));

await step("6. A hand-off sent to the wrong organization is cancelled (cancelTransfer)");
await expectBlocked(
  "Manufacturer tries to ship straight to the Pharmacy, skipping the distributor",
  registry.connect(manufacturer).initiateTransfer.staticCall(batchId, pharmacy.address),
  "InvalidRecipient",
);
await send(
  "initiateTransfer to Distributor B (the wrong distributor)",
  registry.connect(manufacturer).initiateTransfer(batchId, distributorB.address),
);
await show(batchId);
await expectBlocked(
  "Manufacturer opens a second hand-off while the first is still open",
  registry.connect(manufacturer).initiateTransfer.staticCall(batchId, distributor.address),
  "TransferAlreadyPending",
);
await send("cancelTransfer", registry.connect(manufacturer).cancelTransfer(batchId));
await show(batchId);

await step("7. Manufacturer starts a hand-off to the Distributor");
await send("initiateTransfer", registry.connect(manufacturer).initiateTransfer(batchId, distributor.address));
await show(batchId);

await step("8. The Pharmacy tries to accept a hand-off meant for the Distributor");
await expectBlocked(
  "Pharmacy calls acceptTransfer",
  registry.connect(pharmacy).acceptTransfer.staticCall(batchId),
  "NotPendingCustodian",
);
await expectBlocked(
  "Distributor B, whose hand-off was cancelled, calls acceptTransfer",
  registry.connect(distributorB).acceptTransfer.staticCall(batchId),
  "NotPendingCustodian",
);
await expectBlocked(
  "Outsider calls acceptTransfer",
  registry.connect(outsider).acceptTransfer.staticCall(batchId),
  "MissingEitherRole",
);

await step("9. Oracle anchors a sensor log while the lot is in transit (anchorSensorLog)");
const transitLog = documents.add(
  sensorLog({
    ...deployment,
    lotId: Number(batchId),
    ...range,
    endedAt: await chainTime(),
    readingsTenthsC: [41, 44, 47, 52, 49, 45],
  }),
);
console.log(`  sensor log file ${transitLog.cid}`);
await expectBlocked(
  "Distributor tries to anchor a sensor log itself",
  registry.connect(distributor).anchorSensorLog.staticCall(batchId, transitLog),
  "AccessControlUnauthorizedAccount",
);
await send("anchorSensorLog (log #1)", registry.connect(oracle).anchorSensorLog(batchId, transitLog));

await step("10. Distributor accepts and becomes the custodian");
await send("acceptTransfer", registry.connect(distributor).acceptTransfer(batchId));
await show(batchId);

await step("11. Distributor moves the lot between its own sites (updateStatus)");
await send(
  "updateStatus Stored -> InTransit (warehouse to truck)",
  registry.connect(distributor).updateStatus(batchId, statusId("InTransit")),
);
await show(batchId);
await expectBlocked(
  "Distributor B, who does not hold this lot, calls updateStatus",
  registry.connect(distributorB).updateStatus.staticCall(batchId, statusId("Stored")),
  "NotCustodian",
);
await expectBlocked(
  "Distributor tries to set the lot Delivered, which only the pharmacy may do",
  registry.connect(distributor).updateStatus.staticCall(batchId, statusId("Delivered")),
  "InvalidStatusTransition",
);
await send(
  "updateStatus InTransit -> Stored (truck to second warehouse)",
  registry.connect(distributor).updateStatus(batchId, statusId("Stored")),
);
await show(batchId);

await step("12. Oracle anchors a sensor log in storage; an in-range reading is no excursion");
const storageLog = documents.add(
  sensorLog({
    ...deployment,
    lotId: Number(batchId),
    ...range,
    endedAt: await chainTime(),
    readingsTenthsC: [38, 36, 35, 37, 40, 39],
  }),
);
console.log(`  sensor log file ${storageLog.cid}`);
await send("anchorSensorLog (log #2)", registry.connect(oracle).anchorSensorLog(batchId, storageLog));
await expectBlocked(
  "Oracle reports an excursion of 5.0 C, inside the 2.0-8.0 C range",
  registry.connect(oracle).reportExcursion.staticCall(batchId, 50, await chainTime(), storageLog),
  "ReadingWithinRange",
);
await expectBlocked(
  "Oracle reports an excursion of 8.0 C, the upper bound itself",
  registry.connect(oracle).reportExcursion.staticCall(batchId, 80, await chainTime(), storageLog),
  "ReadingWithinRange",
);

await step("13. Distributor hands the lot to the Pharmacy, Pharmacy accepts");
await send("initiateTransfer", registry.connect(distributor).initiateTransfer(batchId, pharmacy.address));
await show(batchId);
await send("acceptTransfer", registry.connect(pharmacy).acceptTransfer(batchId));
await show(batchId);

await step("14. Pharmacy marks the lot Delivered");
await send("markDelivered", registry.connect(pharmacy).markDelivered(batchId));
await show(batchId);
await expectBlocked(
  "Oracle tries to anchor another log after delivery",
  registry.connect(oracle).anchorSensorLog.staticCall(batchId, storageLog),
  "InvalidStatus",
);

console.log("\n----- Lot B: a cold-chain failure -----");

await step("15. A second lot is registered and shipped to the Distributor");
console.log(`  product ${productCode}, lot ${lotNumberB}`);
await send(
  "registerBatch",
  registry.connect(manufacturer).registerBatch(productHashB, manufactureDate, 20, 80, metadataB),
);
const batchIdB = await registry.batchIdOf(productHashB);
await send("initiateTransfer", registry.connect(manufacturer).initiateTransfer(batchIdB, distributor.address));
await send("acceptTransfer", registry.connect(distributor).acceptTransfer(batchIdB));
const routineLogB = documents.add(
  sensorLog({
    ...deployment,
    lotId: Number(batchIdB),
    ...range,
    endedAt: await chainTime(),
    readingsTenthsC: [43, 46, 44, 48, 51, 50],
  }),
);
await send("anchorSensorLog (log #1)", registry.connect(oracle).anchorSensorLog(batchIdB, routineLogB));
await show(batchIdB);

await step("16. On the way to the Pharmacy the oracle reports 11.4 C (reportExcursion)");
await send("initiateTransfer", registry.connect(distributor).initiateTransfer(batchIdB, pharmacy.address));
await show(batchIdB);
// The log's last reading is the one reported on-chain, with its own time.
const excursionDocument = sensorLog({
  ...deployment,
  lotId: Number(batchIdB),
  ...range,
  endedAt: await chainTime(),
  readingsTenthsC: [52, 61, 79, 96, 108, 114],
  reportExcursion: true,
});
const excursionLog = documents.add(excursionDocument);
console.log(`  sensor log file ${excursionLog.cid}`);
await send(
  `reportExcursion (${celsius(excursionDocument.excursion.tenthsC)} C, above the 8.0 C limit; log #2)`,
  registry
    .connect(oracle)
    .reportExcursion(batchIdB, excursionDocument.excursion.tenthsC, excursionDocument.excursion.t, excursionLog),
);
await show(batchIdB);
console.log("  The open hand-off was cleared: the lot stays with the Distributor.");

await step("17. The compromised lot can no longer change hands");
await expectBlocked(
  "Pharmacy calls acceptTransfer",
  registry.connect(pharmacy).acceptTransfer.staticCall(batchIdB),
  "NoPendingTransfer",
);
await expectBlocked(
  "Distributor starts a new hand-off to the Pharmacy",
  registry.connect(distributor).initiateTransfer.staticCall(batchIdB, pharmacy.address),
  "InvalidStatus",
);

await step("18. Regulator recalls the lot (recallBatch)");
const recallReason = "Temperature excursion in transit: 11.4 C, above the 8.0 C limit";
await expectBlocked(
  "Distributor calls recallBatch",
  registry.connect(distributor).recallBatch.staticCall(batchIdB, recallReason),
  "AccessControlUnauthorizedAccount",
);
await expectBlocked(
  "Regulator recalls without giving a reason",
  registry.connect(regulator).recallBatch.staticCall(batchIdB, ""),
  "EmptyReason",
);
await send("recallBatch", registry.connect(regulator).recallBatch(batchIdB, recallReason));
await show(batchIdB);
await expectBlocked(
  "Regulator tries to certify the recalled lot (Recalled is final)",
  registry.connect(regulator).issueCertificate.staticCall(batchIdB, certificate),
  "InvalidStatus",
);

await step("19. Patient view: read-only, no wallet, no role");
const total = await reader.totalBatches();
console.log(`  The registry holds ${total} lot(s).`);
console.log("  Each file is fetched by its on-chain CID (here: from this script's memory) and hashed again.");
await patientView(batchId, lotNumber);
await patientView(batchIdB, lotNumberB);
console.log("");
await expectBlocked(
  `A QR code that names lot ${total + 1n}, which the registry never issued`,
  reader.verifyBatch(total + 1n),
  "BatchNotFound",
);

if (singleWallet) {
  // For the report: where the registry is, and what this run sent, by step.
  console.log("\n----- Transactions of this run -----");
  console.log(`Registry: ${explorer ? `${explorer}/address/${registryAddress}` : registryAddress}`);
  let title;
  let gasUsed = 0n;
  let feesPaid = 0n;
  for (const { step: stepTitle, label, receipt } of sent) {
    if (stepTitle !== title) console.log(`\n${(title = stepTitle)}`);
    console.log(`  ${label}: ${transactionReference(receipt.hash)}`);
    gasUsed += receipt.gasUsed;
    feesPaid += receipt.fee;
  }
  console.log(`\n${sent.length} transactions, ${gasUsed} gas, ${coins(feesPaid)} paid in fees.`);
}

rl?.close();
if (problems > 0) {
  console.log(`\nDone, with ${problems} problem(s): see the lines marked "!!".`);
  process.exitCode = 1;
} else {
  console.log("\nDone.");
}
