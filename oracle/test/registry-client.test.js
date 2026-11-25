/**
 * Tests for the registry client (src/oracle/registryClient.js and its parts
 * deployment.js and revert.js): the only code of the oracle that talks to
 * the chain.
 *
 * No node is started and no socket is opened:
 *   - deployment loading reads fixture files written to a temporary directory;
 *   - the client runs against FakeChain (test/helpers/fake-chain.js), an
 *     in-memory JSON-RPC endpoint behind a real ethers provider, so requests
 *     and answers pass through ethers' real ABI coding and error mapping.
 *
 * The contract ABI used throughout is the committed one
 * (deployments/abi/ProvenanceRegistry.json), so these tests also notice if
 * the interface the oracle relies on changes.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { before, describe, test } from "node:test";
import { inspect } from "node:util";

import { Interface, Wallet, getAddress, id } from "ethers";

import { loadConfig } from "../src/config.js";
import { ChainError, ContractRevertError, DeploymentError, LotNotFoundError, NonceConsumedError, PreflightError, TransientChainError } from "../src/errors.js";
import {
  LOCAL_CHAIN_ID,
  LOCAL_ORACLE_ACCOUNT_INDEX,
  REQUIRED_FUNCTIONS,
  STATUS_NAMES,
  connectRegistry,
  createProvider,
  decodeRevert,
  extractRevertData,
  isActiveStatus,
  loadDeployment,
  statusName,
} from "../src/oracle/registryClient.js";
import { createScrubber, describeFailure, isAlreadyPending, isNodeRefusal, isTransientFailure } from "../src/oracle/rpcErrors.js";
import { FakeChain, syntheticKey, transportError } from "./helpers/fake-chain.js";
import { temporaryDirectory } from "./helpers/harness.js";

const REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
/** Twenty synthetic "unlocked accounts", like a development node offers. They are patterns, not real accounts. */
const ACCOUNTS = Array.from({ length: 20 }, (_, index) => `0x${(index + 1).toString(16).padStart(2, "0").repeat(20)}`);
const LOCAL_ORACLE = ACCOUNTS[LOCAL_ORACLE_ACCOUNT_INDEX];
const REFERENCE = { cid: "bafkreico3mky7o2d4zhu3i2epvch6c3f3aptcbslzg2z5v3ekm7uhxhbpi", contentHash: `0x${"ab".repeat(32)}` };
const noSleep = async () => {};

/** @type {object[]} the committed registry ABI */
let ABI;
/** @type {Interface} */
let CONTRACT;
before(async () => {
  ABI = JSON.parse(await readFile(loadConfig({}).paths.abiFile, "utf8"));
  CONTRACT = new Interface(ABI);
});

/**
 * A configuration whose deployment files live in a temporary directory instead of the repository.
 * @param {string} dir
 * @param {Record<string, string>} [env]
 */
function configIn(dir, env = {}) {
  const config = loadConfig(env);
  return {
    ...config,
    paths: {
      ...config.paths,
      repoRoot: dir,
      deploymentFile: path.join(dir, "deployments", `${config.network}.json`),
      abiFile: path.join(dir, "deployments", "abi", "ProvenanceRegistry.json"),
    },
  };
}

/** Write deployment fixture files. Pass `record: undefined` or `abi: undefined` to leave a file out. */
async function writeFixtures(dir, { network = "localhost", record, abi } = {}) {
  await mkdir(path.join(dir, "deployments", "abi"), { recursive: true });
  if (record !== undefined) await writeFile(path.join(dir, "deployments", `${network}.json`), typeof record === "string" ? record : JSON.stringify(record, null, 2));
  if (abi !== undefined) await writeFile(path.join(dir, "deployments", "abi", "ProvenanceRegistry.json"), typeof abi === "string" ? abi : JSON.stringify(abi, null, 2));
}

/** A deployment record as scripts/deploy.js writes it. */
function record(overrides = {}) {
  return { contract: "ProvenanceRegistry", network: "localhost", chainId: 31337, address: REGISTRY, deployBlock: 7, txHash: `0x${"cd".repeat(32)}`, abi: ABI, ...overrides };
}

/** Assert that a promise rejects with a DeploymentError whose message matches every pattern. */
async function rejectsDeployment(promise, code, ...patterns) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DeploymentError, `expected DeploymentError, got ${error?.stack ?? error}`);
    assert.equal(error.code, code);
    for (const pattern of patterns) assert.match(error.message, pattern);
    return true;
  });
}

/**
 * Connect the real client to a fresh FakeChain.
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]      configuration variables
 * @param {object} [options.chain]                    FakeChain options
 * @param {(chain: FakeChain) => void} [options.prepare]  change the chain before connecting
 * @param {object} [options.client]                   extra connectRegistry options
 * @param {string} [options.address]                  registry address in the deployment record (default: where the fake registry is)
 */
async function connect({ env = {}, chain: chainOptions = {}, prepare = () => {}, client = {}, address } = {}) {
  const config = loadConfig(env);
  const signer = config.oraclePrivateKey === null ? LOCAL_ORACLE : new Wallet(config.oraclePrivateKey.reveal()).address;
  const chain = new FakeChain({ abi: ABI, chainId: config.expectedChainId, accounts: ACCOUNTS, oracles: [signer], development: config.expectedChainId === LOCAL_CHAIN_ID, ...chainOptions });
  prepare(chain);
  const deployment = { address: address ?? chain.registry, chainId: config.expectedChainId, deployBlock: 7, abi: ABI, addressSource: `deployments/${config.network}.json`, abiSource: "deployments/abi/ProvenanceRegistry.json" };
  const registry = await connectRegistry({ config, deployment, provider: chain.provider({ networkName: config.network, expectedChainId: config.expectedChainId }), sleep: noSleep, ...client });
  return { chain, registry, config, signer };
}

/** Assert that connecting fails a given pre-flight check; returns the error. */
async function rejectsPreflight(options, check, ...patterns) {
  let caught;
  await assert.rejects(connect(options), (error) => {
    assert.ok(error instanceof PreflightError, `expected PreflightError, got ${error?.stack ?? error}`);
    assert.equal(error.check, check);
    assert.equal(error.code, "PREFLIGHT_FAILED");
    for (const pattern of patterns) assert.match(error.message, pattern);
    caught = error;
    return true;
  });
  return caught;
}

describe("the committed ABI", () => {
  test("describes every function, event and error the oracle relies on", () => {
    for (const name of REQUIRED_FUNCTIONS) assert.ok(CONTRACT.hasFunction(name), name);
    for (const name of ["SensorLogAnchored", "ExcursionReported"]) assert.ok(CONTRACT.hasEvent(name), name);
    for (const name of ["BatchNotFound", "InvalidStatus", "EmptyDocument", "ReadingWithinRange", "InvalidTimestamp", "AccessControlUnauthorizedAccount"]) {
      assert.ok(CONTRACT.getError(name) !== null, name);
    }
    assert.equal(CONTRACT.getFunction("anchorSensorLog").format("sighash"), "anchorSensorLog(uint256,(string,bytes32))");
    assert.equal(CONTRACT.getFunction("reportExcursion").format("sighash"), "reportExcursion(uint256,int16,uint64,(string,bytes32))");
    assert.equal(CONTRACT.getEvent("SensorLogAnchored").format("sighash"), "SensorLogAnchored(uint256,uint32,string,bytes32)");
    assert.equal(CONTRACT.getEvent("ExcursionReported").format("sighash"), "ExcursionReported(uint256,uint32,int16,uint64,string,bytes32)");
  });
});

describe("loading the deployment record and the ABI", () => {
  test("address, chain id and deploy block come from deployments/<NETWORK>.json, the ABI from deployments/abi/", async (t) => {
    const dir = await temporaryDirectory(t);
    await writeFixtures(dir, { record: record({ address: REGISTRY.toLowerCase(), abi: [] }), abi: ABI });
    const deployment = await loadDeployment(configIn(dir));
    assert.deepEqual(
      { address: deployment.address, chainId: deployment.chainId, deployBlock: deployment.deployBlock, addressSource: deployment.addressSource, abiSource: deployment.abiSource },
      { address: REGISTRY, chainId: 31337, deployBlock: 7, addressSource: path.join("deployments", "localhost.json"), abiSource: path.join("deployments", "abi", "ProvenanceRegistry.json") },
    );
    assert.equal(deployment.abi.length, ABI.length, "the committed ABI file wins over the (here empty) copy in the record");
  });

  test("a missing record produces an instruction, not a stack trace", async (t) => {
    const dir = await temporaryDirectory(t);
    await writeFixtures(dir, { abi: ABI });
    await rejectsDeployment(loadDeployment(configIn(dir)), "DEPLOYMENT_MISSING", /No deployment record at deployments.localhost\.json/, /npm run node/, /npm run deploy:local/, /npm run roles:local/, /REGISTRY_ADDRESS/);
    await rejectsDeployment(loadDeployment(configIn(dir, { NETWORK: "amoy" })), "DEPLOYMENT_MISSING", /deployments.amoy\.json/, /npm run deploy:amoy/);
  });

  test("the record must belong to the chain that NETWORK names", async (t) => {
    const dir = await temporaryDirectory(t);
    await writeFixtures(dir, { record: record({ chainId: 80002, network: "amoy" }), abi: ABI });
    await rejectsDeployment(loadDeployment(configIn(dir)), "DEPLOYMENT_INVALID", /recorded on chain id 80002/, /NETWORK=localhost means chain id 31337/);

    const amoyDir = await temporaryDirectory(t);
    await writeFixtures(amoyDir, { network: "amoy", record: record({ chainId: 31337 }), abi: ABI });
    await rejectsDeployment(loadDeployment(configIn(amoyDir, { NETWORK: "amoy" })), "DEPLOYMENT_INVALID", /recorded on chain id 31337/, /NETWORK=amoy means chain id 80002/);
  });

  test("REGISTRY_ADDRESS overrides the address and makes the record optional", async (t) => {
    const other = getAddress("0x00000000000000000000000000000000000000aa");
    const withoutRecord = await temporaryDirectory(t);
    await writeFixtures(withoutRecord, { abi: ABI });
    const first = await loadDeployment(configIn(withoutRecord, { REGISTRY_ADDRESS: other.toLowerCase() }));
    assert.deepEqual({ address: first.address, deployBlock: first.deployBlock, addressSource: first.addressSource }, { address: other, deployBlock: null, addressSource: "REGISTRY_ADDRESS" });

    const withRecord = await temporaryDirectory(t);
    await writeFixtures(withRecord, { record: record(), abi: ABI });
    const second = await loadDeployment(configIn(withRecord, { REGISTRY_ADDRESS: other }));
    assert.deepEqual({ address: second.address, deployBlock: second.deployBlock }, { address: other, deployBlock: 7 });
  });

  test("the ABI falls back to the copy inside the record, and a Hardhat artifact is accepted", async (t) => {
    const recordOnly = await temporaryDirectory(t);
    await writeFixtures(recordOnly, { record: record() });
    const fromRecord = await loadDeployment(configIn(recordOnly));
    assert.equal(fromRecord.abi.length, ABI.length);
    assert.equal(fromRecord.abiSource, path.join("deployments", "localhost.json"));

    const artifact = await temporaryDirectory(t);
    await writeFixtures(artifact, { record: record({ abi: undefined }), abi: { contractName: "ProvenanceRegistry", abi: ABI } });
    assert.equal((await loadDeployment(configIn(artifact))).abi.length, ABI.length);
  });

  test("no ABI anywhere is an error that names the command that writes it", async (t) => {
    const dir = await temporaryDirectory(t);
    await writeFixtures(dir, { record: record({ abi: undefined }) });
    await rejectsDeployment(loadDeployment(configIn(dir)), "DEPLOYMENT_MISSING", /No contract ABI/, /npm run compile/);
  });

  test("an ABI of another contract is refused", async (t) => {
    const dir = await temporaryDirectory(t);
    const foreign = ABI.filter((entry) => entry.name !== "reportExcursion" && entry.name !== "anchorSensorLog");
    await writeFixtures(dir, { record: record(), abi: foreign });
    await rejectsDeployment(loadDeployment(configIn(dir)), "DEPLOYMENT_INVALID", /lacks anchorSensorLog, reportExcursion/, /npm run compile/);

    const broken = await temporaryDirectory(t);
    // Two fallback functions cannot belong to one contract; ethers refuses such an ABI.
    await writeFixtures(broken, { record: record(), abi: [{ type: "fallback", stateMutability: "payable" }, { type: "fallback", stateMutability: "payable" }] });
    await rejectsDeployment(loadDeployment(configIn(broken)), "DEPLOYMENT_INVALID", /cannot be parsed/);
  });

  test("unusable record files are explained", async (t) => {
    const cases = [
      ["{ not json", /is not valid JSON/],
      ["[]", /is not a deployment record/],
      [JSON.stringify(record({ chainId: "31337" })), /has no numeric "chainId"/],
      [JSON.stringify(record({ address: undefined })), /has no valid "address"/],
      [JSON.stringify(record({ address: "0x1234" })), /has no valid "address"/],
    ];
    for (const [content, pattern] of cases) {
      const dir = await temporaryDirectory(t);
      await writeFixtures(dir, { record: content, abi: ABI });
      await rejectsDeployment(loadDeployment(configIn(dir)), "DEPLOYMENT_INVALID", pattern);
    }
  });

  test("a record without a usable deployBlock still loads", async (t) => {
    const dir = await temporaryDirectory(t);
    await writeFixtures(dir, { record: record({ deployBlock: "unknown" }), abi: ABI });
    assert.equal((await loadDeployment(configIn(dir))).deployBlock, null);
  });

  test("connectRegistry loads the deployment itself and fails before any network access when it is missing", async (t) => {
    const dir = await temporaryDirectory(t);
    const chain = new FakeChain({ abi: ABI, accounts: ACCOUNTS, oracles: [LOCAL_ORACLE] });
    await rejectsDeployment(connectRegistry({ config: configIn(dir), provider: chain.provider() }), "DEPLOYMENT_MISSING", /No deployment record/);
    assert.equal(chain.requests.length, 0);

    await writeFixtures(dir, { record: record(), abi: ABI });
    const registry = await connectRegistry({ config: configIn(dir), provider: chain.provider() });
    assert.equal(registry.address, REGISTRY);
    assert.equal(registry.info.deployBlock, 7);
  });
});

describe("pre-flight checks", () => {
  test("on the local node the oracle signs with unlocked account #4 and needs no key", async () => {
    const { registry, chain } = await connect({ prepare: (fake) => fake.addLot() });
    assert.deepEqual(
      { ...registry.info },
      {
        network: "localhost",
        chainId: 31337,
        address: REGISTRY,
        addressSource: "deployments/localhost.json",
        deployBlock: 7,
        signerAddress: LOCAL_ORACLE,
        signerSource: "local account #4",
        totalLots: 1,
        warnings: [],
      },
    );
    assert.deepEqual({ chainId: registry.chainId, address: registry.address, signerAddress: registry.signerAddress }, { chainId: 31337, address: REGISTRY, signerAddress: LOCAL_ORACLE });
    assert.equal(chain.count("eth_sendTransaction") + chain.count("eth_sendRawTransaction") + chain.count("evm_mine"), 0, "the pre-flight only reads");
  });

  test("with ORACLE_PRIVATE_KEY the wallet signs, and the key appears nowhere", async () => {
    const key = syntheticKey();
    const { registry, signer } = await connect({ env: { ORACLE_PRIVATE_KEY: key } });
    assert.equal(registry.signerAddress, signer);
    assert.equal(registry.info.signerSource, "ORACLE_PRIVATE_KEY");
    const printed = `${inspect(registry, { depth: 6, showHidden: true })} ${JSON.stringify(registry)} ${JSON.stringify(registry.info)}`;
    assert.ok(!printed.includes(key.slice(2)), "the private key must not be printable through the client");
  });

  test("an unreachable endpoint says how to start the node", async () => {
    const error = await rejectsPreflight({ prepare: (chain) => chain.script("eth_chainId", { transport: transportError("ECONNREFUSED") }) }, "rpc", /Cannot reach the JSON-RPC endpoint http:\/\/127\.0\.0\.1:8545/, /npm run node/);
    assert.doesNotMatch(error.message, /\n\s+at /, "no stack trace in the message");
    await rejectsPreflight({ env: { NETWORK: "amoy", ORACLE_PRIVATE_KEY: syntheticKey() }, prepare: (chain) => chain.script("eth_chainId", { transport: transportError("ETIMEDOUT") }) }, "rpc", /Check RPC_URL/);
  });

  test("a wrong chain id is caught before anything else is read", async () => {
    let fake;
    await rejectsPreflight(
      {
        prepare: (chain) => {
          fake = chain;
          chain.chainId = 1337;
        },
      },
      "chain-id",
      /is on chain id 1337/,
      /NETWORK=localhost means chain id 31337/,
    );
    assert.deepEqual(fake.requests.map((request) => request.method), ["eth_chainId"]);

    // NETWORK=amoy pointed at a local node.
    await rejectsPreflight({ env: { NETWORK: "amoy", ORACLE_PRIVATE_KEY: syntheticKey() }, prepare: (chain) => (chain.chainId = 31337) }, "chain-id", /is on chain id 31337/, /NETWORK=amoy means chain id 80002/);
  });

  test("no code at the registry address: the saved deployment is stale", async () => {
    await rejectsPreflight({ prepare: (chain) => chain.code.clear() }, "code", new RegExp(`No contract at ${REGISTRY} on chain id 31337`), /restarted local node/, /npm run deploy:local/, /npm run roles:local/);
    await rejectsPreflight({ env: { NETWORK: "amoy", ORACLE_PRIVATE_KEY: syntheticKey() }, prepare: (chain) => chain.code.clear() }, "code", /belongs to this network/);
  });

  test("a contract that is not the registry is recognised", async () => {
    const stranger = getAddress("0x00000000000000000000000000000000000000bb");
    // Code exists at the recorded address, but calls to it return nothing a registry would return.
    await rejectsPreflight({ address: stranger, prepare: (chain) => chain.code.set(stranger, "0x6000") }, "code", new RegExp(`The contract at ${stranger} does not answer like a ProvenanceRegistry`), /npm run deploy:local/);
  });

  test("a public network needs ORACLE_PRIVATE_KEY, and that is known without asking the network", async () => {
    const chain = new FakeChain({ abi: ABI, chainId: 80002, accounts: ACCOUNTS, oracles: [LOCAL_ORACLE] });
    const config = loadConfig({ NETWORK: "amoy" });
    const deployment = { address: REGISTRY, chainId: 80002, deployBlock: 1, abi: ABI, addressSource: "deployments/amoy.json", abiSource: "x" };
    await assert.rejects(connectRegistry({ config, deployment, provider: chain.provider({ networkName: "amoy" }) }), (error) => {
      assert.ok(error instanceof PreflightError);
      assert.equal(error.check, "signer");
      assert.match(error.message, /ORACLE_PRIVATE_KEY is not set/);
      assert.match(error.message, /oracle\/\.env/);
      return true;
    });
    assert.equal(chain.requests.length, 0, "unlocked accounts are never used outside the local chain");
  });

  test("a node with fewer than five unlocked accounts cannot provide account #4", async () => {
    await rejectsPreflight({ chain: { accounts: ACCOUNTS.slice(0, 4) } }, "signer", /offers 4 unlocked account\(s\)/, /account #4/, /ORACLE_PRIVATE_KEY/);
    await rejectsPreflight({ chain: { accounts: [] } }, "signer", /offers 0 unlocked account/);
  });

  test("a signer without ORACLE_ROLE is told who grants it", async () => {
    await rejectsPreflight({ chain: { oracles: [] } }, "role", new RegExp(`${LOCAL_ORACLE} \\(local account #4\\) does not hold ORACLE_ROLE`), /npm run roles:local/);
    const key = syntheticKey("7a");
    const address = new Wallet(key).address;
    await rejectsPreflight({ env: { NETWORK: "amoy", ORACLE_PRIVATE_KEY: key }, chain: { oracles: [] } }, "role", new RegExp(`npm run roles:amoy" with ORACLE_ADDRESS=${address}`));
  });

  test("an unfunded account is a warning, not a failure", async () => {
    const { registry } = await connect({ prepare: (chain) => (chain.balance = 0n) });
    assert.equal(registry.info.warnings.length, 1);
    assert.match(registry.info.warnings[0], /zero balance/);
  });

  test("an unexpected answer during the checks is still a pre-flight failure", async () => {
    await rejectsPreflight({ prepare: (chain) => chain.script("eth_getCode", { rpcError: { code: -32601, message: "the method eth_getCode does not exist/is not available" } }) }, "rpc", /unexpected answer during the pre-flight checks/);
  });

  test("the RPC URL, which may hold an API key, never appears in an error message", async () => {
    const secretUrl = "https://rpc.example.org/v2/api-key-4d1e8a77c0?token=tok-99";
    const error = await rejectsPreflight(
      {
        env: { NETWORK: "amoy", RPC_URL: secretUrl, ORACLE_PRIVATE_KEY: syntheticKey() },
        prepare: (chain) => chain.script("eth_chainId", { transport: Object.assign(new Error(`request to ${secretUrl} failed`), { code: "ECONNRESET" }) }),
      },
      "rpc",
      /Cannot reach the JSON-RPC endpoint https:\/\/rpc\.example\.org\/\[hidden\]/,
    );
    assert.ok(!error.message.includes("api-key-4d1e8a77c0"));
    assert.ok(!error.message.includes("tok-99"));
  });

  test("createProvider builds a provider for the configured network without contacting it", () => {
    const provider = createProvider(loadConfig({ NETWORK: "amoy" }));
    try {
      assert.equal(provider._network.chainId, 80002n);
      assert.equal(provider._network.name, "amoy");
      // No fee-data plugin: gas prices come from the configured endpoint, not from a third-party service.
      assert.equal(provider._network.plugins.length, 0);
    } finally {
      provider.destroy();
    }
  });
});

describe("reading", () => {
  test("readLot returns the on-chain record in plain numbers", async () => {
    const { registry } = await connect({
      prepare: (chain) => {
        chain.addLot({ status: 1, minTenthsC: -250, maxTenthsC: -150 });
        chain.addLot({ status: 5 });
      },
    });
    const lot = await registry.readLot(1);
    assert.deepEqual(
      { id: lot.id, status: lot.status, statusName: lot.statusName, active: lot.active, range: lot.range, sensorLogCount: lot.sensorLogCount, latestSensorLog: lot.latestSensorLog, registeredAt: lot.registeredAt },
      { id: 1, status: 1, statusName: "InTransit", active: true, range: { minTenthsC: -250, maxTenthsC: -150 }, sensorLogCount: 0, latestSensorLog: { cid: "", contentHash: `0x${"00".repeat(32)}` }, registeredAt: 1_794_300_000 },
    );
    const recalled = await registry.readLot(2);
    assert.deepEqual({ statusName: recalled.statusName, active: recalled.active }, { statusName: "Recalled", active: false });
    assert.equal(await registry.totalLots(), 2);
  });

  test("an unknown lot is a LotNotFoundError (the contract's BatchNotFound)", async () => {
    const { registry } = await connect();
    await assert.rejects(registry.readLot(3), (error) => error instanceof LotNotFoundError && error.lotId === 3 && /Lot 3 does not exist/.test(error.message));
    await assert.rejects(registry.readLot(0), LotNotFoundError);
  });

  test("a broken connection is a TransientChainError; a node error that will not go away is a ChainError", async () => {
    const { registry, chain } = await connect({ prepare: (fake) => fake.addLot() });
    chain.script("eth_call", { transport: transportError("ECONNRESET") });
    await assert.rejects(registry.readLot(1), (error) => error instanceof TransientChainError && /^Reading lot 1 failed: /.test(error.message) && error.code === "CHAIN_UNAVAILABLE");

    chain.script("eth_call", { rpcError: { code: -32000, message: "header not found" } });
    await assert.rejects(registry.totalLots(), TransientChainError);
    chain.script("eth_call", { rpcError: { code: -32005, message: "Too Many Requests: rate limit exceeded" } });
    await assert.rejects(registry.totalLots(), TransientChainError);

    chain.script("eth_call", { rpcError: { code: -32602, message: "invalid argument 0: json: cannot unmarshal" } });
    await assert.rejects(registry.totalLots(), (error) => error instanceof ChainError && !(error instanceof TransientChainError) && /cannot unmarshal/.test(error.message));

    assert.equal((await registry.readLot(1)).id, 1, "the client is usable again afterwards");
  });

  test("reserveNonce is the account's transaction count including pending ones", async () => {
    const { registry, chain, signer } = await connect({ prepare: (fake) => fake.addLot() });
    assert.equal(await registry.reserveNonce(), 0);
    chain.nonces.set(signer, 41);
    assert.equal(await registry.reserveNonce(), 41);
    assert.deepEqual(chain.requests.at(-1), { method: "eth_getTransactionCount", params: [signer.toLowerCase(), "pending"] });
  });
});

describe("the chain's clock", () => {
  test("chainTime is the timestamp of the latest block", async () => {
    const { registry, chain } = await connect({ chain: { time: 1_794_311_111 } });
    assert.equal(await registry.chainTime(), 1_794_311_111);
    assert.equal(await registry.chainTime({ atLeast: 1_794_311_111 }), 1_794_311_111);
    assert.equal(await registry.chainTime({ atLeast: 1_794_000_000 }), 1_794_311_111);
    assert.equal(chain.count("evm_mine"), 0, "a head that is recent enough is never nudged");
  });

  test("on the local development chain a stale head is advanced with one empty block", async () => {
    let wallClock = 1_794_300_600;
    const { registry, chain } = await connect({ chain: { time: 1_794_300_000, wallClock: () => wallClock } });
    const head = await registry.chainTime({ atLeast: 1_794_300_590 });
    assert.equal(head, 1_794_300_600, "the new block carries the node's current time");
    assert.equal(chain.count("evm_mine"), 1);
    assert.equal(chain.count("eth_sendTransaction"), 0, "no transaction is involved");

    // If even the new block is older than asked for, the head is returned as it is; the caller compares.
    wallClock = 1_794_300_700;
    assert.equal(await registry.chainTime({ atLeast: 1_794_309_999 }), 1_794_300_700);
  });

  test("a local node without evm_mine is tolerated: the stale head is reported", async () => {
    const { registry, chain } = await connect({ chain: { development: false } });
    assert.equal(await registry.chainTime({ atLeast: chain.time + 500 }), chain.time);
    assert.equal(chain.count("evm_mine"), 1);
  });

  test("on a public chain the client waits for blocks and never asks the node to mine", async () => {
    const waits = [];
    let fake;
    const { registry, chain } = await connect({
      env: { NETWORK: "amoy", ORACLE_PRIVATE_KEY: syntheticKey() },
      chain: { time: 1_794_300_000 },
      client: {
        sleep: async (ms) => {
          waits.push(ms);
          if (waits.length === 3) fake.time = 1_794_300_010; // a block arrives during the third wait
        },
      },
      prepare: (created) => (fake = created),
    });
    assert.equal(await registry.chainTime({ atLeast: 1_794_300_004 }), 1_794_300_010);
    assert.deepEqual(waits, [1000, 1000, 1000]);

    // The chain does not advance: the wait is bounded, and the stale head is returned.
    waits.length = 0;
    fake.time = 1_794_300_010;
    assert.equal(await registry.chainTime({ atLeast: 1_794_399_999 }), 1_794_300_010);
    assert.equal(waits.length, 6);
    assert.equal(chain.count("evm_mine"), 0);
  });
});

describe("writing", () => {
  test("anchorSensorLog simulates, sends with the reserved nonce, and returns the lot's log number from the event", async () => {
    const { registry, chain, signer } = await connect({ prepare: (fake) => fake.addLot() });
    const nonce = await registry.reserveNonce();
    const submission = await registry.anchorSensorLog(1, REFERENCE, { nonce });

    assert.match(submission.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(submission.logIndex, 1);
    assert.equal(typeof submission.blockNumber, "number");
    assert.deepEqual(chain.lots.get(1).latest, REFERENCE);

    const methods = chain.requests.map((request) => request.method);
    assert.ok(methods.indexOf("eth_estimateGas") < methods.indexOf("eth_sendTransaction"), "the call is simulated before it is sent");
    const [sent] = chain.requests.find((request) => request.method === "eth_sendTransaction").params;
    assert.equal(sent.from, signer.toLowerCase());
    assert.equal(sent.to, REGISTRY.toLowerCase());
    assert.equal(BigInt(sent.nonce), BigInt(nonce));
    assert.equal(BigInt(sent.gas), 108_000n, "gas limit = the estimate of 90000 plus 20 %");
    assert.equal(sent.data, CONTRACT.encodeFunctionData("anchorSensorLog", [1, REFERENCE]));

    const second = await registry.anchorSensorLog(1, { ...REFERENCE, contentHash: `0x${"cd".repeat(32)}` }, { nonce: await registry.reserveNonce() });
    assert.equal(second.logIndex, 2);
  });

  test("reportExcursion sends the reading and its time, and the lot becomes Compromised", async () => {
    const { registry, chain } = await connect({ prepare: (fake) => fake.addLot() });
    const observedAt = chain.time - 30;
    const submission = await registry.reportExcursion(1, { tenthsC: 91, t: observedAt }, REFERENCE, { nonce: await registry.reserveNonce() });
    assert.equal(submission.logIndex, 1);
    const [sent] = chain.requests.find((request) => request.method === "eth_sendTransaction").params;
    assert.equal(sent.data, CONTRACT.encodeFunctionData("reportExcursion", [1, 91, observedAt, REFERENCE]));
    assert.equal((await registry.readLot(1)).statusName, "Compromised");
  });

  test("negative temperatures are encoded as int16", async () => {
    const { registry, chain } = await connect({ prepare: (fake) => fake.addLot({ minTenthsC: -250, maxTenthsC: -150 }) });
    await registry.reportExcursion(1, { tenthsC: -268, t: chain.time }, REFERENCE, { nonce: 0 });
    const [sent] = chain.requests.find((request) => request.method === "eth_sendTransaction").params;
    assert.equal(CONTRACT.decodeFunctionData("reportExcursion", sent.data)[1], -268n);
  });

  test("with a private key the transaction is signed locally and sent raw", async () => {
    const { registry, chain, signer } = await connect({ env: { ORACLE_PRIVATE_KEY: syntheticKey() }, prepare: (fake) => fake.addLot() });
    const submission = await registry.anchorSensorLog(1, REFERENCE, { nonce: await registry.reserveNonce() });
    assert.equal(chain.count("eth_sendRawTransaction"), 1);
    assert.equal(chain.count("eth_sendTransaction"), 0);
    assert.equal(chain.receipts.get(submission.txHash).from, signer);
    assert.equal(submission.logIndex, 1);
  });

  test("a call the contract would reject is stopped by the simulation: nothing is sent", async () => {
    const { registry, chain } = await connect({
      prepare: (fake) => {
        fake.addLot({ status: 3 }); // Delivered
        fake.addLot(); // Stored, range 2.0 to 8.0 C
      },
    });
    const cases = [
      [() => registry.anchorSensorLog(1, REFERENCE, { nonce: 0 }), "InvalidStatus", { batchId: 1, current: "Delivered" }, /InvalidStatus\(batchId=1, current=Delivered\).*no longer active/],
      [() => registry.reportExcursion(1, { tenthsC: 95, t: chain.time }, REFERENCE, { nonce: 0 }), "InvalidStatus", { batchId: 1, current: "Delivered" }, /InvalidStatus/],
      [() => registry.anchorSensorLog(9, REFERENCE, { nonce: 0 }), "BatchNotFound", { batchId: 9 }, /BatchNotFound\(batchId=9\).*no lot has this id/],
      [() => registry.reportExcursion(2, { tenthsC: 80, t: chain.time }, REFERENCE, { nonce: 0 }), "ReadingWithinRange", { readingTenthsC: 80, minTempTenthsC: 20, maxTempTenthsC: 80 }, /ReadingWithinRange\(readingTenthsC=80, minTempTenthsC=20, maxTempTenthsC=80\).*bounds included/],
      [() => registry.reportExcursion(2, { tenthsC: 20, t: chain.time }, REFERENCE, { nonce: 0 }), "ReadingWithinRange", { readingTenthsC: 20, minTempTenthsC: 20, maxTempTenthsC: 80 }, /ReadingWithinRange/],
      [() => registry.reportExcursion(2, { tenthsC: 95, t: chain.time + 3600 }, REFERENCE, { nonce: 0 }), "InvalidTimestamp", { timestamp: chain.time + 3600 }, /InvalidTimestamp\(timestamp=\d+\).*later than the block timestamp/],
      [() => registry.reportExcursion(2, { tenthsC: 95, t: 0 }, REFERENCE, { nonce: 0 }), "InvalidTimestamp", { timestamp: 0 }, /InvalidTimestamp\(timestamp=0\)/],
      [() => registry.anchorSensorLog(2, { cid: "", contentHash: REFERENCE.contentHash }, { nonce: 0 }), "EmptyDocument", {}, /EmptyDocument\(\).*empty CID or a zero content hash/],
    ];
    for (const [call, errorName, args, pattern] of cases) {
      await assert.rejects(call, (error) => {
        assert.ok(error instanceof ContractRevertError, `expected ContractRevertError, got ${error?.stack ?? error}`);
        assert.equal(error.errorName, errorName);
        assert.deepEqual(error.args, args);
        assert.match(error.message, pattern);
        assert.equal(error.code, "CONTRACT_REVERT");
        return true;
      });
    }
    assert.equal(chain.count("eth_sendTransaction"), 0, "no rejected call was ever broadcast");
    assert.equal(chain.receipts.size, 0);
  });

  test("a role that was revoked after start-up is reported by name", async () => {
    const { registry, chain, signer } = await connect({ prepare: (fake) => fake.addLot() });
    chain.oracles.clear();
    await assert.rejects(registry.anchorSensorLog(1, REFERENCE, { nonce: 0 }), (error) => {
      assert.ok(error instanceof ContractRevertError);
      assert.equal(error.errorName, "AccessControlUnauthorizedAccount");
      assert.deepEqual(error.args, { account: signer, neededRole: "ORACLE_ROLE" });
      assert.match(error.message, /does not hold the role/);
      return true;
    });
  });

  test("a reserved nonce is required", async () => {
    const { registry } = await connect({ prepare: (fake) => fake.addLot() });
    await assert.rejects(registry.anchorSensorLog(1, REFERENCE, {}), TypeError);
    await assert.rejects(registry.reportExcursion(1, { tenthsC: 95, t: 5 }, REFERENCE, { nonce: -1 }), TypeError);
  });

  test("signed transaction, lost answer: the retry finds the mined transaction and does not send again", async () => {
    const { registry, chain } = await connect({ env: { ORACLE_PRIVATE_KEY: syntheticKey() }, prepare: (fake) => fake.addLot() });
    const nonce = await registry.reserveNonce();
    chain.script("eth_sendRawTransaction", { loseResponse: true });

    await assert.rejects(registry.anchorSensorLog(1, REFERENCE, { nonce }), TransientChainError);
    assert.equal(chain.lots.get(1).sensorLogCount, 1, "the transaction was mined although the client never heard back");

    const submission = await registry.anchorSensorLog(1, REFERENCE, { nonce });
    assert.equal(submission.logIndex, 1);
    assert.equal(chain.count("eth_sendRawTransaction"), 1, "the second attempt looked the earlier transaction up instead of sending");
    assert.equal(chain.lots.get(1).sensorLogCount, 1);
  });

  test("node-signed transaction, lost answer: the resend with the same nonce is refused, so nothing is anchored twice", async () => {
    const { registry, chain } = await connect({ prepare: (fake) => fake.addLot() });
    const nonce = await registry.reserveNonce();
    chain.script("eth_sendTransaction", { loseResponse: true });

    await assert.rejects(registry.anchorSensorLog(1, REFERENCE, { nonce }), TransientChainError);
    await assert.rejects(registry.anchorSensorLog(1, REFERENCE, { nonce }), (error) => error instanceof NonceConsumedError && error.nonce === nonce && error.code === "NONCE_CONSUMED");
    assert.equal(chain.lots.get(1).sensorLogCount, 1, "exactly one log, whatever the client was told");
    assert.equal(chain.receipts.size, 1);
  });

  test("a transaction that is not mined in time leaves its outcome open, and a later attempt picks it up", async () => {
    const { registry, chain } = await connect({ env: { ORACLE_PRIVATE_KEY: syntheticKey() }, prepare: (fake) => fake.addLot(), client: { receiptTimeoutMs: 300 } });
    const nonce = await registry.reserveNonce();
    chain.script("eth_getTransactionReceipt", { result: null }, 3);

    let openHash;
    await assert.rejects(registry.anchorSensorLog(1, REFERENCE, { nonce }), (error) => {
      assert.ok(error instanceof TransientChainError);
      assert.match(error.message, /was not mined within 0 s; its outcome is still open/);
      assert.match(error.txHash, /^0x[0-9a-f]{64}$/);
      openHash = error.txHash;
      return true;
    });

    const submission = await registry.anchorSensorLog(1, REFERENCE, { nonce });
    assert.equal(submission.txHash, openHash);
    assert.equal(chain.count("eth_sendRawTransaction"), 1);
  });

  test("'already known' from the node means our transaction is waiting: the client waits for it", async () => {
    const { registry, chain } = await connect({ env: { ORACLE_PRIVATE_KEY: syntheticKey() }, prepare: (fake) => fake.addLot(), client: { receiptTimeoutMs: 300 } });
    const nonce = await registry.reserveNonce();
    chain.script("eth_getTransactionReceipt", { result: null }, 4); // three polls of the first attempt, one look-up of the second
    await assert.rejects(registry.anchorSensorLog(1, REFERENCE, { nonce }), TransientChainError);

    chain.script("eth_sendRawTransaction", { rpcError: { code: -32000, message: "already known" } });
    const submission = await registry.anchorSensorLog(1, REFERENCE, { nonce });
    assert.equal(submission.logIndex, 1);
    assert.equal(chain.lots.get(1).sensorLogCount, 1);
  });

  test("a transaction that is mined but reverted is reported as a contract rejection", async () => {
    const { registry, chain } = await connect({ prepare: (fake) => fake.addLot() });
    chain.script("eth_getTransactionReceipt", { result: (params, handle) => ({ ...handle(), status: "0x0", logs: [] }) });
    await assert.rejects(registry.anchorSensorLog(1, REFERENCE, { nonce: 0 }), (error) => error instanceof ContractRevertError && /was mined in block \d+ but reverted/.test(error.message));
  });

  test("an account that cannot pay for gas gets a clear instruction", async () => {
    const { registry, chain, signer } = await connect({ prepare: (fake) => fake.addLot() });
    chain.script("eth_estimateGas", { rpcError: { code: -32000, message: "insufficient funds for gas * price + value" } });
    await assert.rejects(registry.anchorSensorLog(1, REFERENCE, { nonce: 0 }), (error) => error instanceof ChainError && error.code === "INSUFFICIENT_FUNDS" && error.message.includes(signer) && /faucet/.test(error.message));
    assert.equal(chain.count("eth_sendTransaction"), 0);
  });

  test("a connection that drops during the simulation is transient, and nothing was sent", async () => {
    const { registry, chain } = await connect({ prepare: (fake) => fake.addLot() });
    chain.script("eth_estimateGas", { transport: transportError("ECONNRESET") });
    await assert.rejects(registry.anchorSensorLog(1, REFERENCE, { nonce: 0 }), (error) => error instanceof TransientChainError && /^Anchoring a sensor log for lot 1 failed/.test(error.message) && error.txHash === null);
    assert.equal(chain.count("eth_sendTransaction"), 0);
    assert.equal((await registry.anchorSensorLog(1, REFERENCE, { nonce: 0 })).logIndex, 1);
  });

  test("close releases the provider", async () => {
    const { registry } = await connect();
    await registry.close();
    await assert.rejects(registry.totalLots());
  });
});

describe("classifying RPC failures", () => {
  /** Errors in the shapes ethers 6 and Node.js produce them (observed with a mock HTTP endpoint). */
  const ethersError = (code, shortMessage, extra = {}) => Object.assign(new Error(`${shortMessage} (code=${code})`), { code, shortMessage, ...extra });
  const rpcError = (message, code = "UNKNOWN_ERROR") => ethersError(code, "could not coalesce error", { error: { code: -32000, message } });

  test("an endpoint that cannot be reached, times out or answers with a server error is transient", () => {
    const transient = [
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:59321"), { code: "ECONNREFUSED" }),
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
      new TypeError("fetch failed"),
      ethersError("TIMEOUT", "request timeout"),
      ethersError("SERVER_ERROR", "server response 500 Internal Server Error"),
      ethersError("NETWORK_ERROR", "network changed"),
      ethersError("UNSUPPORTED_OPERATION", "response body is not valid JSON"),
      rpcError("header not found"),
      rpcError("Too Many Requests: rate limit exceeded"),
      rpcError("request timed out"),
      // ethers reports any error answer to eth_call as a call exception, even a rate limit.
      ethersError("CALL_EXCEPTION", "missing revert data", { data: null, info: { error: { code: -32005, message: "rate limit exceeded" } } }),
    ];
    for (const error of transient) assert.equal(isTransientFailure(error), true, error.message);
  });

  test("a revert, a refusal that will not go away and a programming error are not transient", () => {
    const permanent = [
      ethersError("CALL_EXCEPTION", "execution reverted", { data: "0x12345678", info: { error: { code: 3, message: "execution reverted" } } }),
      // A revert reason may contain any text; it is still a revert.
      ethersError("CALL_EXCEPTION", "execution reverted", { data: null, info: { error: { code: 3, message: "execution reverted: request timed out" } } }),
      rpcError("invalid argument 0: json: cannot unmarshal hex string"),
      ethersError("UNSUPPORTED_OPERATION", "unsupported operation", { info: { error: { code: -32601, message: "the method evm_mine does not exist/is not available" } } }),
      ethersError("INSUFFICIENT_FUNDS", "insufficient funds"),
      ethersError("NONCE_EXPIRED", "nonce has already been used"),
      new TypeError("Cannot read properties of undefined"),
      new Error("anything else"),
      null,
      undefined,
    ];
    for (const error of permanent) assert.equal(isTransientFailure(error), false, String(error?.message));
  });

  test("a node's own refusal is told apart from a contract revert", () => {
    assert.equal(isNodeRefusal(rpcError("invalid argument 0")), true);
    assert.equal(isNodeRefusal(ethersError("CALL_EXCEPTION", "missing revert data", { data: null, info: { error: { message: "rate limit exceeded" } } })), true);
    assert.equal(isNodeRefusal(ethersError("CALL_EXCEPTION", "execution reverted", { data: "0x12345678", info: { error: { message: "rate limit exceeded" } } })), false, "revert data present");
    assert.equal(isNodeRefusal(ethersError("CALL_EXCEPTION", "execution reverted", { data: null, info: { error: { message: "execution reverted" } } })), false);
    assert.equal(isNodeRefusal(ethersError("CALL_EXCEPTION", "missing revert data", { data: null })), false, "no answer from the node to judge by");
    assert.equal(isNodeRefusal(new Error("socket hang up")), false);
  });

  test("a transaction that is already in the mempool is recognised by the node's wording", () => {
    for (const message of ["already known", "known transaction: 0xabc", "replacement transaction underpriced", "transaction already imported", "ALREADY_EXISTS: already exists"]) {
      assert.equal(isAlreadyPending(rpcError(message)), true, message);
    }
    assert.equal(isAlreadyPending(ethersError("REPLACEMENT_UNDERPRICED", "replacement fee too low")), true);
    assert.equal(isAlreadyPending(rpcError("nonce too low")), false);
    assert.equal(isAlreadyPending(new Error("already known")), false, "only the node's answer counts, not any text");
  });

  test("failure texts are short, come from the node when it answered, and never contain the RPC URL", () => {
    const url = "https://user:pass-77@rpc.example.org/v2/api-key-4d1e8a77c0?token=tok-99";
    const scrub = createScrubber(url);
    assert.equal(scrub(`request to ${url} failed`), "request to [hidden] failed");
    assert.equal(scrub("GET /v2/api-key-4d1e8a77c0?token=tok-99 returned 500"), "GET [hidden] returned 500");
    assert.equal(scrub("credentials user:pass-77 rejected"), "credentials [hidden] rejected");
    // A URL without a path has nothing but itself to hide, and "/" is left alone.
    assert.equal(createScrubber("http://127.0.0.1:8545")("a/b http://127.0.0.1:8545 c"), "a/b [hidden] c");
    assert.equal(createScrubber("not a url")("unchanged text"), "unchanged text");

    assert.equal(describeFailure(rpcError("header not found"), scrub), "header not found");
    assert.equal(describeFailure(ethersError("SERVER_ERROR", "server response 500 Internal Server Error", { info: { requestUrl: url } }), scrub), "server response 500 Internal Server Error");
    assert.equal(describeFailure(new Error(`connect ECONNREFUSED\n  at ${url}.`), scrub), "connect ECONNREFUSED at [hidden]");
    assert.equal(describeFailure("plain text.", scrub), "plain text");
    assert.equal(describeFailure(new Error("x".repeat(1000)), scrub).length, 300);
  });
});

describe("decoding contract errors", () => {
  /** An error as ethers throws it for a reverted call. */
  const callException = (data) => Object.assign(new Error("execution reverted (unknown custom error)"), { code: "CALL_EXCEPTION", data, reason: null });

  test("every custom error the oracle can meet is decoded with named, readable arguments", () => {
    const account = getAddress("0x00000000000000000000000000000000000000a4");
    const cases = [
      ["BatchNotFound", [12], "BatchNotFound(batchId=12)", { batchId: 12 }],
      ["InvalidStatus", [3, 4], "InvalidStatus(batchId=3, current=Compromised)", { batchId: 3, current: "Compromised" }],
      ["InvalidStatus", [3, 5], "InvalidStatus(batchId=3, current=Recalled)", { batchId: 3, current: "Recalled" }],
      ["InvalidStatusTransition", [1, 0, 3], "InvalidStatusTransition(batchId=1, from=Created, to=Delivered)", { batchId: 1, from: "Created", to: "Delivered" }],
      ["EmptyDocument", [], "EmptyDocument()", {}],
      ["ReadingWithinRange", [-200, -250, -150], "ReadingWithinRange(readingTenthsC=-200, minTempTenthsC=-250, maxTempTenthsC=-150)", { readingTenthsC: -200, minTempTenthsC: -250, maxTempTenthsC: -150 }],
      ["InvalidTimestamp", [1_794_302_580], "InvalidTimestamp(timestamp=1794302580)", { timestamp: 1_794_302_580 }],
      ["AccessControlUnauthorizedAccount", [account, id("ORACLE_ROLE")], `AccessControlUnauthorizedAccount(account=${account}, neededRole=ORACLE_ROLE)`, { account, neededRole: "ORACLE_ROLE" }],
      ["AccessControlUnauthorizedAccount", [account, `0x${"00".repeat(32)}`], `AccessControlUnauthorizedAccount(account=${account}, neededRole=DEFAULT_ADMIN_ROLE)`, { account, neededRole: "DEFAULT_ADMIN_ROLE" }],
      ["MissingEitherRole", [account, id("MANUFACTURER_ROLE"), id("DISTRIBUTOR_ROLE")], `MissingEitherRole(account=${account}, roleA=MANUFACTURER_ROLE, roleB=DISTRIBUTOR_ROLE)`, { account, roleA: "MANUFACTURER_ROLE", roleB: "DISTRIBUTOR_ROLE" }],
    ];
    for (const [name, values, detail, args] of cases) {
      const decoded = decodeRevert(callException(CONTRACT.encodeErrorResult(name, values)), CONTRACT);
      assert.ok(decoded instanceof ContractRevertError);
      assert.equal(decoded.errorName, name);
      assert.equal(decoded.detail, detail);
      assert.deepEqual(decoded.args, args);
      assert.ok(decoded.message.startsWith(`The contract rejected the call: ${detail}`));
      assert.equal(decoded.data, CONTRACT.encodeErrorResult(name, values));
    }
  });

  test("the revert data is found wherever a node puts it", () => {
    const data = CONTRACT.encodeErrorResult("InvalidStatus", [2, 4]);
    const shapes = [
      { code: "CALL_EXCEPTION", data },
      { code: "CALL_EXCEPTION", data: null, info: { error: { code: 3, message: "execution reverted", data } } },
      { code: "UNKNOWN_ERROR", error: { code: -32603, message: "VM Exception while processing transaction", data: { message: "reverted with custom error", data } } },
      { code: "UNKNOWN_ERROR", error: { code: -32000, message: "execution reverted", data: { originalError: { data } } } },
    ];
    for (const shape of shapes) {
      assert.equal(extractRevertData(shape), data);
      assert.equal(decodeRevert(shape, CONTRACT).detail, "InvalidStatus(batchId=2, current=Compromised)");
    }
  });

  test("the request that was sent is never mistaken for revert data", () => {
    const calldata = CONTRACT.encodeFunctionData("totalBatches", []);
    const error = { code: "UNKNOWN_ERROR", error: { code: -32000, message: "header not found" }, payload: { method: "eth_call", params: [{ to: REGISTRY, data: calldata }] }, info: { payload: { params: [{ data: calldata }] } } };
    assert.equal(extractRevertData(error), null);
    assert.equal(decodeRevert(error, CONTRACT), null);
  });

  test("revert strings, panics, unknown selectors and empty reverts are still described", () => {
    const coder = new Interface(["error Error(string)", "error Panic(uint256)"]);
    const withString = decodeRevert(callException(coder.encodeErrorResult("Error", ["AccessControl: missing role"])), CONTRACT);
    assert.equal(withString.errorName, "Error");
    assert.match(withString.detail, /AccessControl: missing role/);

    const panic = decodeRevert(callException(coder.encodeErrorResult("Panic", [0x11])), CONTRACT);
    assert.equal(panic.errorName, "Panic");

    const unknown = decodeRevert(callException("0xdeadbeef"), CONTRACT);
    assert.equal(unknown.errorName, "unknown");
    assert.match(unknown.message, /unknown custom error with selector 0xdeadbeef/);
    assert.match(unknown.message, /newer than the ABI file/);

    const empty = decodeRevert(Object.assign(new Error("missing revert data"), { code: "CALL_EXCEPTION", data: null, reason: null }), CONTRACT);
    assert.equal(empty.errorName, "unknown");
    assert.match(empty.detail, /execution reverted \(no reason given\)/);
    const withReason = decodeRevert(Object.assign(new Error("x"), { code: "CALL_EXCEPTION", data: "0x", reason: "require(false)" }), CONTRACT);
    assert.match(withReason.detail, /require\(false\)/);
  });

  test("an error that is not a revert is not decoded", () => {
    for (const error of [new Error("socket hang up"), Object.assign(new Error("timeout"), { code: "TIMEOUT" }), null, undefined, "text", { code: "NETWORK_ERROR" }]) {
      assert.equal(decodeRevert(error, CONTRACT), null);
    }
  });

  test("status names follow the contract's enum, and exactly the first three are active", () => {
    assert.deepEqual(STATUS_NAMES, ["Created", "InTransit", "Stored", "Delivered", "Compromised", "Recalled"]);
    assert.deepEqual(STATUS_NAMES.map((_, status) => isActiveStatus(status)), [true, true, true, false, false, false]);
    assert.equal(statusName(2n), "Stored");
    assert.equal(statusName(9), "Status(9)");
    for (const bad of [-1, 6, 1.5, Number.NaN]) assert.equal(isActiveStatus(bad), false);
    assert.equal(isActiveStatus(1n), true);
  });
});
