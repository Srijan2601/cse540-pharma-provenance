// Gas report: what each transaction of the registry costs, and what a whole
// lot costs from registration to delivery (or to recall).
//
// Usage:
//   npm run gas:report                                      gas only
//   GAS_PRICE_GWEI=30 POL_USD=0.25 npm run gas:report       adds cost columns
//
// Optional environment variables:
//   GAS_PRICE_GWEI   gas price to assume, in gwei. Adds a cost column in POL.
//   POL_USD          price of 1 POL in US dollars. With GAS_PRICE_GWEI, adds a cost column in USD.
// Take both from a dated source and quote the date in the report: this script
// does not look prices up, so that its numbers can be reproduced.
//
// Output:
//   a table on the terminal
//   docs/analysis/data/gas-report.json   machine-readable, with the compiler settings and the code fingerprint
//   docs/analysis/data/gas-report.md     the same numbers as Markdown tables
// Commit both files whenever the contract changes:
// test/tooling/gas-report-sync.test.js fails while the committed report was
// measured on other code.
//
// How the numbers are measured. The script deploys a fresh registry on
// Hardhat's in-process network and sends real transactions, one per block.
// Every number is `gasUsed` from a transaction receipt, so it includes the
// 21,000 base cost and the calldata, as on a public chain. The figures are
// those of Hardhat's network (its hardfork is in the report header). Polygon
// Amoy charged more gas for the same calls: in the demo run of 2026-11-26
// every registry call used 9,240 to 27,720 more gas, 21% more in total
// (docs/amoy-deployment.md). For costs on Amoy, quote its receipts. The gas
// PRICE differs between networks as well, which is why prices are an input
// here and not something this script decides.
//
// The scenario is deterministic: fixed accounts, fixed lot numbers, fixed
// documents and fixed timestamps in the calldata. Two runs on the same code
// give identical files, so a change in the numbers of the committed report
// always means the contract or the compiler settings changed. For the same
// reason the files carry no generation time and no git commit (a report
// written before a commit could never name that commit). They name the
// measured code by its fingerprint instead (scripts/lib/gas-report-stamp.js).
//
// Why some functions have several rows. The cost of a storage write depends
// on what the slot held before: filling an empty slot costs 20,000 gas,
// changing a value that is already there 2,900. A document reference takes
// four slots (three for the 59-character CID, one for the hash). So the first
// sensor log of a lot, which fills latestSensorLog, costs far more than every
// later one, which overwrites it, and likewise for the first certificate.
// Where a function has such a first-call cost, both cases are measured.
import { artifacts, network } from "hardhat";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { documentRef } from "./lib/cid.js";
import { GAS_REPORT_JSON_PATH, GAS_REPORT_MARKDOWN_PATH, codeFingerprint } from "./lib/gas-report-stamp.js";

const COMMAND = "npm run gas:report";
const repositoryRoot = new URL("../", import.meta.url);

const connection = await network.create();
const { ethers, networkName } = connection;
if (networkName !== "default") {
  throw new Error("The gas report runs on the in-process network only: omit --network.");
}

// ---------------------------------------------------------------------------
// Optional prices
// ---------------------------------------------------------------------------

// Prices stay decimal strings, so the gas price can be converted to wei
// exactly and the report quotes the values as they were given.
function positiveDecimal(name, maxDecimals) {
  const text = process.env[name]?.trim();
  if (!text) return undefined;
  const match = /^\d+(?:\.(\d+))?$/.exec(text);
  if (!match || Number(text) <= 0 || (match[1]?.length ?? 0) > maxDecimals) {
    throw new Error(`${name} must be a positive decimal number with at most ${maxDecimals} decimals, such as 30 or 0.25.`);
  }
  return text;
}

const gasPriceGwei = positiveDecimal("GAS_PRICE_GWEI", 9); // 1 gwei = 10^9 wei
const polUsd = positiveDecimal("POL_USD", 8);
if (polUsd && !gasPriceGwei) {
  console.log("Note: POL_USD is ignored without GAS_PRICE_GWEI, because a cost needs a gas price first.\n");
}
// Wei per unit of gas, as an exact integer (gwei has 9 decimals).
const gasPriceWei = gasPriceGwei ? ethers.parseUnits(gasPriceGwei, "gwei") : undefined;
const showUsd = Boolean(gasPriceWei && polUsd);

/** Cost fields for a gas amount; empty when no gas price was given. */
function cost(gas) {
  if (!gasPriceWei) return {};
  // POL has 18 decimals like ether, so formatEther gives the exact amount.
  const costPol = ethers.formatEther(BigInt(gas) * gasPriceWei);
  return showUsd ? { costPol, costUsd: Number((Number(costPol) * Number(polUsd)).toFixed(8)) } : { costPol };
}

// ---------------------------------------------------------------------------
// Fixed inputs
// ---------------------------------------------------------------------------

// The same account layout as scripts/demo.js and scripts/grant-roles.js.
const [regulator, manufacturer, distributor, pharmacy, oracle, , distributorB] = await ethers.getSigners();

const Status = { Created: 0, InTransit: 1, Stored: 2, Delivered: 3, Compromised: 4, Recalled: 5 };
const MIN_TEMP = 20; // 2.0 C
const MAX_TEMP = 80; // 8.0 C
const EXCURSION_READING = 114; // 11.4 C
// Fixed timestamps (2026-01-01 00:00 and 01:00 UTC), so that the calldata is
// identical on every run. Both lie in the past, which is all the contract
// requires of them; the in-process chain starts at the current time.
const MANUFACTURE_DATE = 1767225600;
const OBSERVED_AT = 1767229200;
const RECALL_REASON = "Temperature excursion in transit: 11.4 C, above the 8.0 C limit";

// A distinct, deterministic document per use. Every CID from this helper is
// 59 characters, so each document reference occupies the same storage and
// calldata as a real one from IPFS.
let documentCount = 0;
function nextDocument(kind) {
  documentCount += 1;
  return documentRef(ethers.toUtf8Bytes(`gas-report ${kind} ${documentCount}`));
}

let lotCount = 0;
function nextProductHash() {
  lotCount += 1;
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "string"], ["NDC-0000-0000-00", `GAS-LOT-${lotCount}`]),
  );
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

async function gasOf(txPromise) {
  const receipt = await (await txPromise).wait();
  return Number(receipt.gasUsed);
}

const operations = [];
/** Send one transaction and record its gas as a row of the per-function table. */
async function measure(fn, caller, scenario, txPromise) {
  const gas = await gasOf(txPromise);
  operations.push({ function: fn, caller, case: scenario, gas, ...cost(gas) });
}

// Deployment. The regulator is the deployer here, as on the local networks.
const registry = await ethers.deployContract("ProvenanceRegistry", [regulator.address]);
const deploymentGas = Number((await registry.deploymentTransaction().wait()).gasUsed);
operations.push({
  function: "constructor",
  caller: "Deployer",
  case: "deploy the registry (once)",
  gas: deploymentGas,
  ...cost(deploymentGas),
});

// The registry as seen by each role's account. The keys are the role names
// used in the report. The second distributor (distributorB) only ever
// receives a hand-off that is then cancelled, so it sends no transaction.
const as = {
  Regulator: registry.connect(regulator),
  Manufacturer: registry.connect(manufacturer),
  Distributor: registry.connect(distributor),
  Pharmacy: registry.connect(pharmacy),
  Oracle: registry.connect(oracle),
};

// Onboarding. The five grants cost the same apart from a few gas of calldata,
// so one of them is reported.
const DISTRIBUTOR_ROLE = await registry.DISTRIBUTOR_ROLE();
await measure(
  "grantRole",
  "Regulator",
  "onboard an organization",
  as.Regulator.grantRole(await registry.MANUFACTURER_ROLE(), manufacturer.address),
);
await (await as.Regulator.grantRole(DISTRIBUTOR_ROLE, distributor.address)).wait();
await (await as.Regulator.grantRole(DISTRIBUTOR_ROLE, distributorB.address)).wait();
await (await as.Regulator.grantRole(await registry.RETAILER_ROLE(), pharmacy.address)).wait();
await (await as.Regulator.grantRole(await registry.ORACLE_ROLE(), oracle.address)).wait();

const registerBatch = (productHash) =>
  as.Manufacturer.registerBatch(productHash, MANUFACTURE_DATE, MIN_TEMP, MAX_TEMP, nextDocument("metadata"));

/**
 * Set-up for a measurement, not itself recorded: a fresh lot that a
 * distributor has accepted (status Stored, no sensor log yet).
 */
async function lotStoredAtDistributor() {
  const productHash = nextProductHash();
  await gasOf(registerBatch(productHash));
  const lot = await registry.batchIdOf(productHash);
  await gasOf(as.Manufacturer.initiateTransfer(lot, distributor.address));
  await gasOf(as.Distributor.acceptTransfer(lot));
  return lot;
}

// ---------------------------------------------------------------------------
// Per-function measurements
// ---------------------------------------------------------------------------

// Lot 1 makes the whole journey. The cases are measured in the order in which
// a lot meets them.
// The first registration also takes the lot counter from zero to one.
const firstHash = nextProductHash();
await measure("registerBatch", "Manufacturer", "first lot of the registry", registerBatch(firstHash));
const lot1 = await registry.batchIdOf(firstHash);

const secondHash = nextProductHash();
await measure("registerBatch", "Manufacturer", "every later lot", registerBatch(secondHash));
const lot2 = await registry.batchIdOf(secondHash);

await measure(
  "issueCertificate",
  "Regulator",
  "first certificate of a lot",
  as.Regulator.issueCertificate(lot1, nextDocument("certificate")),
);
await measure(
  "issueCertificate",
  "Regulator",
  "replacement certificate",
  as.Regulator.issueCertificate(lot1, nextDocument("certificate")),
);

await measure(
  "initiateTransfer",
  "Manufacturer",
  "to a distributor (lot Created)",
  as.Manufacturer.initiateTransfer(lot1, distributorB.address),
);
await measure("cancelTransfer", "Manufacturer", "lot returns to Created", as.Manufacturer.cancelTransfer(lot1));
await gasOf(as.Manufacturer.initiateTransfer(lot1, distributor.address));

await measure("anchorSensorLog", "Oracle", "first log of a lot", as.Oracle.anchorSensorLog(lot1, nextDocument("log")));
await measure("anchorSensorLog", "Oracle", "every later log", as.Oracle.anchorSensorLog(lot1, nextDocument("log")));

await measure("acceptTransfer", "Distributor", "a distributor accepts", as.Distributor.acceptTransfer(lot1));
await measure(
  "updateStatus",
  "Distributor",
  "Stored -> InTransit",
  as.Distributor.updateStatus(lot1, Status.InTransit),
);
await measure("updateStatus", "Distributor", "InTransit -> Stored", as.Distributor.updateStatus(lot1, Status.Stored));

// The first hand-off that starts from Stored also fills the slot that
// remembers the status for cancelTransfer; a later one overwrites it.
await measure(
  "initiateTransfer",
  "Distributor",
  "to a pharmacy (lot Stored)",
  as.Distributor.initiateTransfer(lot1, pharmacy.address),
);
await measure("cancelTransfer", "Distributor", "lot returns to Stored", as.Distributor.cancelTransfer(lot1));
await measure(
  "initiateTransfer",
  "Distributor",
  "to a pharmacy again, after a cancelled hand-off",
  as.Distributor.initiateTransfer(lot1, pharmacy.address),
);
await measure("acceptTransfer", "Pharmacy", "a pharmacy accepts", as.Pharmacy.acceptTransfer(lot1));
await measure("markDelivered", "Pharmacy", "Stored -> Delivered", as.Pharmacy.markDelivered(lot1));
await measure("recallBatch", "Regulator", "a Delivered lot", as.Regulator.recallBatch(lot1, RECALL_REASON));

// Excursions. Lot 2 has no sensor log yet, so the excursion log is its first.
await measure(
  "reportExcursion",
  "Oracle",
  "first log of the lot, no open hand-off",
  as.Oracle.reportExcursion(lot2, EXCURSION_READING, OBSERVED_AT, nextDocument("log")),
);
await measure("recallBatch", "Regulator", "a Compromised lot", as.Regulator.recallBatch(lot2, RECALL_REASON));

const lot3 = await lotStoredAtDistributor();
await gasOf(as.Oracle.anchorSensorLog(lot3, nextDocument("log")));
await measure(
  "reportExcursion",
  "Oracle",
  "after an earlier log, no open hand-off",
  as.Oracle.reportExcursion(lot3, EXCURSION_READING, OBSERVED_AT, nextDocument("log")),
);

const lot4 = await lotStoredAtDistributor();
await gasOf(as.Oracle.anchorSensorLog(lot4, nextDocument("log")));
await gasOf(as.Distributor.initiateTransfer(lot4, pharmacy.address));
await measure(
  "reportExcursion",
  "Oracle",
  "after an earlier log, clears an open hand-off",
  as.Oracle.reportExcursion(lot4, EXCURSION_READING, OBSERVED_AT, nextDocument("log")),
);

// Recalls of lots that are still active.
const lot5 = await lotStoredAtDistributor();
await measure(
  "recallBatch",
  "Regulator",
  "a Stored lot, no open hand-off",
  as.Regulator.recallBatch(lot5, RECALL_REASON),
);

const lot6 = await lotStoredAtDistributor();
await gasOf(as.Distributor.initiateTransfer(lot6, pharmacy.address));
await measure(
  "recallBatch",
  "Regulator",
  "a lot in transit, clears an open hand-off",
  as.Regulator.recallBatch(lot6, RECALL_REASON),
);

await measure(
  "revokeRole",
  "Regulator",
  "offboard an organization",
  as.Regulator.revokeRole(DISTRIBUTOR_ROLE, distributorB.address),
);

// ---------------------------------------------------------------------------
// Lifecycle totals
// ---------------------------------------------------------------------------

const ROLES = ["Manufacturer", "Regulator", "Distributor", "Pharmacy", "Oracle"];

/**
 * Run the transactions of one lot in order and add up their gas.
 * @param steps  [function name, role that pays, (lotId) => transaction] in order.
 *               The first step must be registerBatch, which creates the lot.
 */
async function lifecycle(id, title, sensorLogs, steps) {
  const productHash = nextProductHash();
  const gasByRole = Object.fromEntries(ROLES.map((role) => [role, 0]));
  const calls = []; // consecutive identical calls are merged, so 100 sensor logs stay one entry
  let lot;
  let total = 0;
  for (const [fn, role, send] of steps) {
    const gas = await gasOf(send(lot, productHash));
    lot ??= await registry.batchIdOf(productHash);
    total += gas;
    gasByRole[role] += gas;
    const previous = calls.at(-1);
    if (previous?.function === fn && previous.role === role) {
      previous.calls += 1;
      previous.gas += gas;
    } else {
      calls.push({ function: fn, role, calls: 1, gas });
    }
  }
  return { id, title, sensorLogs, transactions: steps.length, gas: total, ...cost(total), gasByRole, steps: calls };
}

const register = ["registerBatch", "Manufacturer", (_, productHash) => registerBatch(productHash)];
const toDistributor = [
  ["initiateTransfer", "Manufacturer", (lot) => as.Manufacturer.initiateTransfer(lot, distributor.address)],
  ["acceptTransfer", "Distributor", (lot) => as.Distributor.acceptTransfer(lot)],
];
const sensorLogSteps = (count) =>
  Array.from({ length: count }, () => [
    "anchorSensorLog",
    "Oracle",
    (lot) => as.Oracle.anchorSensorLog(lot, nextDocument("log")),
  ]);
const startToPharmacy = [
  "initiateTransfer",
  "Distributor",
  (lot) => as.Distributor.initiateTransfer(lot, pharmacy.address),
];

// The journey that goes right: registered, certified, shipped to a
// distributor, monitored with N sensor logs, handed to a pharmacy, delivered.
const HAPPY_PATH_LOGS = [0, 1, 10, 100];
const lifecycles = [];
for (const logs of HAPPY_PATH_LOGS) {
  lifecycles.push(
    await lifecycle("happy-path", `Happy path, ${logs} sensor log${logs === 1 ? "" : "s"}`, logs, [
      register,
      ["issueCertificate", "Regulator", (lot) => as.Regulator.issueCertificate(lot, nextDocument("certificate"))],
      ...toDistributor,
      ...sensorLogSteps(logs),
      startToPharmacy,
      ["acceptTransfer", "Pharmacy", (lot) => as.Pharmacy.acceptTransfer(lot)],
      ["markDelivered", "Pharmacy", (lot) => as.Pharmacy.markDelivered(lot)],
    ]),
  );
}

// The cold-chain failure, as in the demo's second lot: one routine log, then
// an excursion on the way to the pharmacy, then the recall.
lifecycles.push(
  await lifecycle("excursion-recall", "Excursion and recall, 2 sensor logs", 2, [
    register,
    ...toDistributor,
    ...sensorLogSteps(1),
    startToPharmacy,
    [
      "reportExcursion",
      "Oracle",
      (lot) => as.Oracle.reportExcursion(lot, EXCURSION_READING, OBSERVED_AT, nextDocument("log")),
    ],
    ["recallBatch", "Regulator", (lot) => as.Regulator.recallBatch(lot, RECALL_REASON)],
  ]),
);

// The scenario above measures the cases in the order a lot meets them. The
// report lists them by function instead, grouped by the role that calls them
// as in proposal Table I, so that the cases of one function stand together.
const FUNCTION_ORDER = [
  "constructor",
  "grantRole",
  "revokeRole",
  "registerBatch",
  "initiateTransfer",
  "acceptTransfer",
  "cancelTransfer",
  "updateStatus",
  "markDelivered",
  "issueCertificate",
  "recallBatch",
  "anchorSensorLog",
  "reportExcursion",
];
// Array.prototype.sort is stable, so the cases of a function keep their order.
operations.sort((a, b) => FUNCTION_ORDER.indexOf(a.function) - FUNCTION_ORDER.indexOf(b.function));

// ---------------------------------------------------------------------------
// Context: what was compiled and measured
// ---------------------------------------------------------------------------

// The build info belongs to the artifact that was just deployed, so it states
// the compiler and settings behind the measured bytecode, even if
// hardhat.config.js has been edited since.
const artifact = await artifacts.readArtifact("ProvenanceRegistry");
const buildInfoPath = await artifacts.getBuildInfoPath(await artifacts.getBuildInfoId("ProvenanceRegistry"));
const buildInfo = JSON.parse(await readFile(buildInfoPath, "utf8"));
const settings = buildInfo.input.settings;

const packageVersion = async (name) =>
  JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, repositoryRoot), "utf8")).version;

// Bytes of runtime code on-chain; EIP-170 caps a contract at 24,576 bytes.
const deployedBytecodeBytes = (artifact.deployedBytecode.length - 2) / 2;

const report = {
  generatedBy: `${COMMAND} (scripts/gas-report.js)`,
  contract: "ProvenanceRegistry",
  compiler: {
    solc: buildInfo.solcLongVersion,
    optimizer: settings.optimizer,
    evmVersion: settings.evmVersion,
    viaIR: settings.viaIR ?? false,
  },
  toolchain: {
    hardhat: await packageVersion("hardhat"),
    openzeppelinContracts: await packageVersion("@openzeppelin/contracts"),
  },
  network: {
    name: "Hardhat in-process network",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    hardfork: connection.networkConfig.hardfork,
  },
  // The artifact deployed above is the one this fingerprint is taken from.
  codeFingerprint: codeFingerprint(artifact),
  deployedBytecodeBytes,
  prices: gasPriceGwei ? { gasPriceGwei, ...(showUsd ? { polUsd } : {}) } : null,
  operations,
  lifecycles,
};

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const number = (value) => value.toLocaleString("en-US");
const costHeaders = gasPriceWei ? ["Cost (POL)", ...(showUsd ? ["Cost (USD)"] : [])] : [];
const costCells = (row) =>
  gasPriceWei ? [Number(row.costPol).toFixed(6), ...(showUsd ? [row.costUsd.toFixed(6)] : [])] : [];

const operationTable = {
  headers: ["Function", "Caller", "Case", "Gas", ...costHeaders],
  rows: operations.map((row) => [row.function, row.caller, row.case, number(row.gas), ...costCells(row)]),
  rightAligned: 3, // index of the first numeric column
};
const lifecycleTable = {
  headers: ["Lifecycle of one lot", "Txs", ...ROLES, "Total gas", ...costHeaders],
  rows: lifecycles.map((row) => [
    row.title,
    String(row.transactions),
    ...ROLES.map((role) => number(row.gasByRole[role])),
    number(row.gas),
    ...costCells(row),
  ]),
  rightAligned: 1,
};

function plainTable({ headers, rows, rightAligned }) {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column].length)));
  const line = (cells) =>
    cells
      .map((cell, column) => (column >= rightAligned ? cell.padStart(widths[column]) : cell.padEnd(widths[column])))
      .join("  ")
      .trimEnd();
  return [line(headers), widths.map((width) => "-".repeat(width)).join("  "), ...rows.map(line)].join("\n");
}

function markdownTable({ headers, rows, rightAligned }) {
  const row = (cells) => `| ${cells.join(" | ")} |`;
  const alignment = headers.map((_, column) => (column >= rightAligned ? "---:" : "---"));
  return [row(headers), row(alignment), ...rows.map(row)].join("\n");
}

const optimizer = settings.optimizer?.enabled ? `enabled, ${settings.optimizer.runs} runs` : "disabled";
const facts = [
  `Compiler: solc ${report.compiler.solc}, optimizer ${optimizer}, EVM target ${report.compiler.evmVersion}`,
  `Toolchain: Hardhat ${report.toolchain.hardhat}, OpenZeppelin Contracts ${report.toolchain.openzeppelinContracts}`,
  `Measured on: ${report.network.name} (chainId ${report.network.chainId}, hardfork ${report.network.hardfork}); gasUsed from transaction receipts`,
  `Code fingerprint: ${report.codeFingerprint} (keccak256 of the creation bytecode without the compiler's metadata hash; checked by test/tooling/gas-report-sync.test.js)`,
  `Deployed bytecode: ${number(deployedBytecodeBytes)} bytes (EIP-170 limit: 24,576)`,
  report.prices
    ? `Prices assumed: gas price ${gasPriceGwei} gwei${showUsd ? `, 1 POL = ${polUsd} USD` : ""}`
    : "Prices: none given, so only gas is shown (set GAS_PRICE_GWEI and POL_USD for cost columns)",
];
const lifecycleNote =
  "Happy path: registerBatch, issueCertificate, initiateTransfer and acceptTransfer (manufacturer to distributor), " +
  "N x anchorSensorLog, initiateTransfer and acceptTransfer (distributor to pharmacy), markDelivered. " +
  "Excursion and recall: registerBatch, hand-off to the distributor, one anchorSensorLog, initiateTransfer to the " +
  "pharmacy, reportExcursion, recallBatch. The role columns show which organization pays for which part.";

console.log("Gas report: ProvenanceRegistry\n");
console.log(facts.map((fact) => `  ${fact}`).join("\n"));
console.log(`\n${plainTable(operationTable)}`);
console.log(`\n${plainTable(lifecycleTable)}`);
console.log(`\n${lifecycleNote}`);

const markdown = [
  `> Generated by \`${COMMAND}\` (scripts/gas-report.js). Do not edit by hand: re-run the command instead.`,
  "",
  "# Gas report: ProvenanceRegistry",
  "",
  ...facts.map((fact) => `- ${fact}`),
  "",
  "## Cost per transaction",
  "",
  "Where the cost of a function depends on whether it ran before (first sensor log of a lot, first certificate, first lot of the registry), both cases are listed.",
  "",
  markdownTable(operationTable),
  "",
  "## Cost per lot",
  "",
  lifecycleNote,
  "",
  markdownTable(lifecycleTable),
  "",
].join("\n");

const jsonFile = new URL(GAS_REPORT_JSON_PATH, repositoryRoot);
const markdownFile = new URL(GAS_REPORT_MARKDOWN_PATH, repositoryRoot);
await mkdir(new URL(".", jsonFile), { recursive: true }); // the folder that holds both files
await writeFile(jsonFile, JSON.stringify(report, null, 2) + "\n");
await writeFile(markdownFile, markdown);
console.log(`\nWrote ${GAS_REPORT_JSON_PATH} and ${GAS_REPORT_MARKDOWN_PATH}`);
