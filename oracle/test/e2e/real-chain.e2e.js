/**
 * End-to-end test of the oracle against the real contract on a real Hardhat node.
 *
 *   npm run test:e2e        (opt-in: "npm test" does not run it)
 *
 * Nothing here is a stand-in. The test starts its own Hardhat node from the
 * repository root on a free port, deploys ProvenanceRegistry from the compiled
 * artifact and drives the oracle's own command-line code against it. It needs
 * only the root project installed and compiled ("npm ci && npx hardhat compile"
 * in the repository root): no key, no network. The node's unlocked accounts
 * sign everything, as on the local demo node: #0 regulator, #1 manufacturer,
 * #4 oracle.
 *
 * What only a real node can show: it accepts the oracle's transactions
 * (account #4, explicit nonce and gas limit); chain record, events and stored
 * file agree for a normal log and an excursion; the log index parsed from the
 * event equals sensorLogCount; an idle node's clock is brought up to the wall
 * clock; a custom error of the real contract is decoded by name.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Contract, ContractFactory, JsonRpcProvider } from "ethers";

import { loadConfig } from "../../src/config.js";
import { computeProductHash, createDocuments } from "../../src/documents/index.js";
import { computeContentHash, createStorage } from "../../src/ipfs/index.js";
import { runOracleCli } from "../../src/oracle/cli.js";
import { connectRegistry } from "../../src/oracle/registryClient.js";

const REPO_ROOT = loadConfig({}).paths.repoRoot;
const ARTIFACT = path.join(REPO_ROOT, "artifacts/contracts/ProvenanceRegistry.sol/ProvenanceRegistry.json");
const HARDHAT_CLI = path.join(REPO_ROOT, "node_modules/hardhat/dist/src/cli.js");
/** Ports of the shared local demo (node, upload service, dApp), which this test must never take. */
const RESERVED_PORTS = [8545, 8787, 5173];
const RANGE = { minTenthsC: 20, maxTenthsC: 80 };
const COMPROMISED = 4;

let hardhat = null;
let provider = null;
let registry;
let deployBlock;
let oracleAddress;
let store;
/** The environment the oracle is configured from; loadConfig reads only this object, never a .env file. */
let env;

/** A port the operating system reports as free on the loopback address. */
async function freePort() {
  for (;;) {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    if (!RESERVED_PORTS.includes(port)) return port;
  }
}

before(async () => {
  const missing = [
    [ARTIFACT, "the compiled contract"],
    [HARDHAT_CLI, "the root project's Hardhat"],
  ].filter(([file]) => !existsSync(file));
  if (missing.length > 0) {
    const message = `The end-to-end test cannot find ${missing.map(([, what]) => what).join(" or ")}. Run "npm ci && npx hardhat compile" in the repository root (${REPO_ROOT}) first.`;
    process.stderr.write(`${message}\n`);
    throw new Error(message);
  }

  const rpcUrl = `http://127.0.0.1:${await freePort()}`;
  // stdout is discarded unread: the node prints the private keys of its test accounts there.
  hardhat = spawn(process.execPath, [HARDHAT_CLI, "node", "--hostname", "127.0.0.1", "--port", new URL(rpcUrl).port], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  hardhat.stderr.on("data", (chunk) => (stderr += chunk));
  // Last resort if the test process ends without running the after hook: the node must not outlive
  // it, and the temporary store is removed.
  process.once("exit", () => {
    hardhat.kill("SIGKILL");
    if (store) rmSync(store, { recursive: true, force: true });
  });
  // An unhandled signal ends this process without that "exit" event. "node --test" handles SIGINT and
  // SIGTERM only in the runner, and a runner that is stopped on its own sends SIGTERM to this process.
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(1));

  for (const deadline = Date.now() + 30_000; ; await delay(200)) {
    if (hardhat.exitCode !== null) throw new Error(`The Hardhat node exited at start-up:\n${stderr}`);
    if (Date.now() > deadline) throw new Error(`The Hardhat node did not answer at ${rpcUrl} within 30 s:\n${stderr}`);
    const answer = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).catch(() => null);
    if (answer?.ok) break;
  }
  provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });

  const { abi, bytecode } = JSON.parse(await readFile(ARTIFACT, "utf8"));
  const [regulator, manufacturer, oracle] = await Promise.all([0, 1, 4].map((index) => provider.getSigner(index)));
  oracleAddress = oracle.address;
  const deployed = await new ContractFactory(abi, bytecode, regulator).deploy(regulator.address);
  deployBlock = (await deployed.deploymentTransaction().wait()).blockNumber;
  registry = new Contract(await deployed.getAddress(), abi, provider);
  for (const [role, account] of [["ORACLE_ROLE", oracle], ["MANUFACTURER_ROLE", manufacturer]]) {
    await (await registry.connect(regulator).grantRole(await registry[role](), account.address)).wait();
  }

  store = await mkdtemp(path.join(os.tmpdir(), "oracle-e2e-"));
  env = { RPC_URL: rpcUrl, REGISTRY_ADDRESS: await registry.getAddress(), IPFS_LOCAL_DIR: store };
  const storage = createStorage(loadConfig(env));
  const documents = createDocuments();
  const madeAt = (await provider.getBlock("latest")).timestamp - 86400;
  for (const lotNumber of ["E2E-0001", "E2E-0002"]) {
    const metadata = documents.buildLotMetadata({
      chainId: 31337, registry: env.REGISTRY_ADDRESS, productCode: "E2E-TEST-001", lotNumber, storage: RANGE, attachments: [],
      productName: "End-to-end test product (synthetic)", manufacturerName: "Test Manufacturing (synthetic)", site: "Plant 1, Example City",
      manufactureDate: madeAt, expiryDate: madeAt + 730 * 86400,
    });
    const { cid } = await storage.add(metadata.bytes, { name: "lot-metadata.json" });
    const productHash = computeProductHash("E2E-TEST-001", lotNumber);
    await (await registry.connect(manufacturer).registerBatch(productHash, madeAt, RANGE.minTenthsC, RANGE.maxTenthsC, { cid, contentHash: metadata.contentHash })).wait();
  }
});

after(async () => {
  provider?.destroy();
  if (hardhat !== null && hardhat.exitCode === null && hardhat.signalCode === null) {
    const exited = new Promise((resolve) => hardhat.once("exit", resolve));
    hardhat.kill("SIGTERM");
    if ((await Promise.race([exited.then(() => true), delay(5000)])) !== true) hardhat.kill("SIGKILL");
  }
  if (store) await rm(store, { recursive: true, force: true });
});

/** Run "oracle:once --json" in-process and return its exit code and result object. */
async function once(...args) {
  const out = [];
  const err = [];
  const code = await runOracleCli(["once", ...args, "--json"], { env, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, result: JSON.parse(out.at(-1)), log: err.join("\n") };
}

/** The stored file of a result: its keccak256 is the on-chain hash, and it is the lot's sensor log. */
async function storedLog(result, lotId) {
  const bytes = await readFile(path.join(store, result.cid));
  assert.equal(computeContentHash(bytes), result.contentHash);
  const { document } = createDocuments().parse(bytes, "sensor-log");
  assert.deepEqual([document.chainId, document.registry, document.lotId], [31337, env.REGISTRY_ADDRESS, lotId]);
  return document;
}

test("a normal log is anchored, and chain record, event and stored file agree", async () => {
  const { code, result, log } = await once("--lot", "1");
  assert.equal(code, 0, log);
  assert.equal(result.outcome, "anchored");

  const lot = await registry.verifyBatch(1);
  assert.equal(Number(lot.sensorLogCount), result.logIndex);
  assert.deepEqual([lot.latestSensorLog.cid, lot.latestSensorLog.contentHash], [result.cid, result.contentHash]);
  const events = await registry.queryFilter(registry.filters.SensorLogAnchored(1), deployBlock);
  assert.deepEqual(
    events.map((e) => [Number(e.args.logIndex), e.args.cid, e.args.contentHash, e.transactionHash]),
    [[1, result.cid, result.contentHash, result.txHash]],
  );
  const sent = await provider.getTransaction(result.txHash);
  assert.equal(sent.from, oracleAddress, "signed by the node's unlocked account #4");
  await storedLog(result, 1);
});

test("an excursion is reported: the lot becomes Compromised and the event matches the log", async () => {
  const { code, result, log } = await once("--lot", "2", "--scenario", "excursion");
  assert.equal(code, 0, log);
  assert.equal(result.outcome, "excursion");
  assert.ok(result.excursion.tenthsC > RANGE.maxTenthsC);

  const lot = await registry.verifyBatch(2);
  assert.equal(Number(lot.status), COMPROMISED);
  assert.equal(Number(lot.sensorLogCount), result.logIndex);
  const events = await registry.queryFilter(registry.filters.ExcursionReported(2), deployBlock);
  assert.deepEqual(
    events.map((e) => [Number(e.args.logIndex), Number(e.args.readingTenthsC), Number(e.args.observedAt), e.args.logCid, e.args.logContentHash]),
    [[result.logIndex, result.excursion.tenthsC, result.excursion.t, result.cid, result.contentHash]],
  );
  assert.deepEqual((await storedLog(result, 2)).excursion, result.excursion);

  const again = await once("--lot", "2");
  assert.deepEqual([again.code, again.result.outcome], [1, "skipped"], "a Compromised lot is left alone");
});

test("a custom error of the real contract is decoded, and an idle node's clock catches up", async () => {
  const client = await connectRegistry({ config: loadConfig(env) });
  try {
    const nonce = await client.reserveNonce();
    const { latestSensorLog } = await client.readLot(2);
    await assert.rejects(client.anchorSensorLog(2, latestSensorLog, { nonce }), (error) => {
      assert.equal(error.errorName, "InvalidStatus");
      assert.deepEqual(error.args, { batchId: 2, current: "Compromised" });
      return true;
    });
    assert.equal(await client.reserveNonce(), nonce, "rejected by the simulation, so nothing was sent");

    // Hardhat stamps blocks at least a second apart, so the setup left the head a few seconds ahead
    // of the wall clock. Once the node has been idle long enough, the head lies in the past.
    for (const deadline = Date.now() + 20_000; (await provider.getBlock("latest")).timestamp >= Math.floor(Date.now() / 1000); await delay(250)) {
      assert.ok(Date.now() < deadline, "the head never fell behind the wall clock");
    }
    const blockBefore = await provider.getBlockNumber();
    const wall = Math.floor(Date.now() / 1000);
    assert.ok((await client.chainTime({ atLeast: wall })) >= wall, "evm_mine brought the head up to the wall clock");
    assert.equal(await provider.getBlockNumber(), blockBefore + 1, "exactly one empty block was mined");
  } finally {
    await client.close();
  }
});
