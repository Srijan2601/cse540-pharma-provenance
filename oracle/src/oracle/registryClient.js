/**
 * The registry client: the ONLY module of the oracle that talks to the chain.
 * The runner sees a small interface
 *
 *   chainId, address, signerAddress
 *   totalLots()                                   -> number
 *   readLot(lotId)                                -> Lot
 *   chainTime({ atLeast })                        -> Unix seconds of the latest block
 *   reserveNonce()                                -> number
 *   anchorSensorLog(lotId, ref, { nonce })        -> { txHash, blockNumber, logIndex }
 *   reportExcursion(lotId, reading, ref, { nonce }) -> { txHash, blockNumber, logIndex }
 *   close()
 *
 * and nothing of ethers, JSON-RPC or the ABI. Tests replace the whole object
 * with an in-memory fake; a real-chain test needs nothing but an RPC URL.
 *
 * connectRegistry() builds the client and runs the pre-flight checks before
 * it returns, so a client that exists is known to be usable:
 *   1. the RPC endpoint answers;
 *   2. it is on the chain that NETWORK and the deployment record name;
 *   3. the registry address holds contract code;
 *   4. a signer is available (ORACLE_PRIVATE_KEY, or the local node's unlocked account #4);
 *   5. that signer holds ORACLE_ROLE.
 * Each failure is a PreflightError that says what to do.
 *
 * Every method makes exactly one attempt and throws a typed error: a
 * TransientChainError when a retry may help, a ContractRevertError with the
 * decoded custom error when the contract said no, a LotNotFoundError, a
 * NonceConsumedError, or a ChainError for anything else. The retry policy
 * lives in the runner.
 *
 * Writing safely. A transaction is sent in three explicit steps:
 *   simulate   eth_estimateGas executes the call against the latest state. A
 *              call the contract would reject fails here, decoded, and no
 *              transaction is sent and no gas is spent.
 *   broadcast  with the account nonce the caller reserved for this document.
 *              Every attempt for the same document reuses that nonce, and a
 *              chain mines at most one transaction per account and nonce, so
 *              a retry can never anchor a document twice (see the runner).
 *   confirm    poll for the receipt. If the answer to the broadcast was lost,
 *              or the receipt does not arrive in time, the transaction hashes
 *              of earlier attempts with the same nonce are remembered and
 *              checked first on the next attempt.
 *
 * The private key is used in exactly one place, to construct the signer. It
 * is never logged, and error messages are built from short descriptions that
 * do not contain the RPC URL, which may carry an API key.
 */

import { Contract, FetchRequest, Interface, JsonRpcProvider, Network, Wallet, keccak256 } from "ethers";

import { describeConfig } from "../config.js";
import {
  ChainError,
  ContractRevertError,
  LotNotFoundError,
  NonceConsumedError,
  OracleError,
  PreflightError,
  TransientChainError,
} from "../errors.js";
import { loadDeployment } from "./deployment.js";
import { abortableSleep } from "./retry.js";
import { decodeRevert, isActiveStatus, statusName } from "./revert.js";
import { createScrubber, describeFailure, isAlreadyPending, isNodeRefusal, isTransientFailure } from "./rpcErrors.js";

export { REQUIRED_FUNCTIONS, loadDeployment } from "./deployment.js";
export { STATUS_NAMES, decodeRevert, extractRevertData, isActiveStatus, statusName } from "./revert.js";

/** Chain id of a local development node (Hardhat). Only there may the oracle use an unlocked account. */
export const LOCAL_CHAIN_ID = 31337;

/** Which unlocked account of the local node is the oracle: "npm run roles:local" grants ORACLE_ROLE to account #4. */
export const LOCAL_ORACLE_ACCOUNT_INDEX = 4;

/** A single JSON-RPC request is abandoned after this long (ethers' own default is five minutes). */
const RPC_TIMEOUT_MS = 15_000;

/** How long to wait for a broadcast transaction to be mined before reporting its outcome as open. */
const RECEIPT_TIMEOUT_MS = 120_000;

/** On a public chain, how long chainTime() waits for new blocks when the head is older than asked for. */
const HEAD_WAIT_MS = 6_000;

/** Gas limit = estimate + 20 %: the state may differ slightly between the simulation and the block. */
const GAS_MARGIN_PERCENT = 120n;

/** Number of nonces whose transaction hashes are remembered for the "was an earlier attempt mined?" check. */
const REMEMBERED_NONCES = 32;

/**
 * @typedef {object} Lot
 * @property {number} id
 * @property {number} status                  value of the contract's Status enum
 * @property {string} statusName              for example "Stored"
 * @property {boolean} active                 Created, InTransit or Stored: the lot accepts sensor data
 * @property {{ minTenthsC: number, maxTenthsC: number }} range   the range fixed at registration
 * @property {number} sensorLogCount          logs anchored so far
 * @property {{ cid: string, contentHash: string }} latestSensorLog   empty cid when none was anchored
 * @property {number} registeredAt            Unix seconds
 * @property {string} custodian               current holder
 *
 * @typedef {{ cid: string, contentHash: string }} DocumentRef
 * @typedef {{ txHash: string, blockNumber: number, logIndex: number|null }} Submission
 *   `logIndex` is the lot's log number from the emitted event (1, 2, 3, ...).
 *
 * @typedef {object} RegistryInfo
 * @property {string} network            NETWORK
 * @property {number} chainId
 * @property {string} address            registry address
 * @property {string} addressSource      file or variable the address came from
 * @property {number|null} deployBlock
 * @property {string} signerAddress
 * @property {string} signerSource       "ORACLE_PRIVATE_KEY" or "local account #4"
 * @property {number} totalLots          lots registered when the client connected
 * @property {string[]} warnings         non-fatal findings, for example an unfunded account
 */

/**
 * Create the JSON-RPC provider for a configuration.
 *
 * The network is fixed up front ("static"): ethers then neither probes the
 * endpoint in the background nor retries forever when it is down; the chain
 * id is checked explicitly by the pre-flight instead. Requests are not
 * batched and not cached, so every call is one request with a fresh answer.
 * The Network object is created without ethers' built-in plugins, so fee
 * data comes from the configured RPC endpoint and no third-party gas service
 * is contacted.
 *
 * @param {import("../config.js").OracleConfig} config
 * @param {{ timeoutMs?: number }} [options]
 * @returns {JsonRpcProvider}
 */
export function createProvider(config, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
  const request = new FetchRequest(config.rpcUrl);
  request.timeout = timeoutMs;
  const network = new Network(config.network, config.expectedChainId);
  return new JsonRpcProvider(request, network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 });
}

/**
 * Connect to the registry: load the deployment, choose the signer, run the
 * pre-flight checks and return a ready client.
 *
 * @param {object} options
 * @param {import("../config.js").OracleConfig} options.config
 * @param {import("./deployment.js").Deployment} [options.deployment]  defaults to loadDeployment(config)
 * @param {JsonRpcProvider} [options.provider]   defaults to createProvider(config); tests pass a fake
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]  wait between polls; tests pass an instant one
 * @param {number} [options.receiptTimeoutMs]    how long to wait for a transaction to be mined
 * @returns {Promise<RegistryClient>}
 * @throws {import("../errors.js").DeploymentError} missing or unusable deployment record or ABI
 * @throws {PreflightError} a pre-flight check failed
 */
export async function connectRegistry({ config, deployment, provider, sleep = abortableSleep, receiptTimeoutMs = RECEIPT_TIMEOUT_MS }) {
  const target = deployment ?? (await loadDeployment(config));
  const local = config.expectedChainId === LOCAL_CHAIN_ID;

  // Checked before any network access: on a public chain there is no unlocked account to fall back to.
  if (config.oraclePrivateKey === null && !local) {
    throw new PreflightError(
      "signer",
      `ORACLE_PRIVATE_KEY is not set. On NETWORK=${config.network} the oracle signs with the key of the wallet that holds ORACLE_ROLE: ` +
        "put its 64 hex digits in the ORACLE_PRIVATE_KEY environment variable (or in oracle/.env, which git ignores). " +
        "Only the local node (NETWORK=localhost) needs no key.",
    );
  }

  const rpc = provider ?? createProvider(config);
  const endpoint = describeConfig(config).rpcUrl;
  const scrub = createScrubber(config.rpcUrl);
  const contractInterface = new Interface(target.abi);

  /**
   * Run one pre-flight request. A request that fails although no check has
   * failed yet means the endpoint is the problem, whatever was being asked.
   * @template T
   * @param {() => Promise<T>} request
   * @returns {Promise<T>}
   */
  const ask = async (request) => {
    try {
      return await request();
    } catch (error) {
      if (!isTransientFailure(error)) throw error;
      throw new PreflightError(
        "rpc",
        `Cannot reach the JSON-RPC endpoint ${endpoint} (${describeFailure(error, scrub)}).\n` +
          (local
            ? 'Start the local node with "npm run node" in the repository root, or point RPC_URL at a running node.'
            : "Check RPC_URL and the network connection."),
        { cause: error },
      );
    }
  };

  try {
    // 1 + 2: the endpoint answers, and it is the expected chain.
    const reported = Number(BigInt(await ask(() => rpc.send("eth_chainId", []))));
    if (reported !== config.expectedChainId) {
      throw new PreflightError(
        "chain-id",
        `The JSON-RPC endpoint ${endpoint} is on chain id ${reported}, but NETWORK=${config.network} means chain id ${config.expectedChainId}. ` +
          "Point RPC_URL at the right network, or change NETWORK.",
      );
    }

    // 3: the address holds a contract. A restarted local node starts empty, which makes a saved address stale.
    const code = await ask(() => rpc.getCode(target.address));
    if (code === "0x") {
      throw new PreflightError(
        "code",
        `No contract at ${target.address} on chain id ${reported} (address from ${target.addressSource}).\n` +
          (local
            ? 'A restarted local node starts with an empty chain, so the saved address is stale: run "npm run deploy:local" and "npm run roles:local" again in the repository root.'
            : "Check that the address belongs to this network."),
      );
    }

    // 4: the signer.
    let signer;
    let signerSource;
    if (config.oraclePrivateKey !== null) {
      // The one place the key is revealed: it goes straight into the wallet object and is never printed.
      signer = new Wallet(config.oraclePrivateKey.reveal(), rpc);
      signerSource = "ORACLE_PRIVATE_KEY";
    } else {
      const accounts = await ask(() => rpc.send("eth_accounts", []));
      if (!Array.isArray(accounts) || accounts.length <= LOCAL_ORACLE_ACCOUNT_INDEX) {
        throw new PreflightError(
          "signer",
          `The node at ${endpoint} offers ${Array.isArray(accounts) ? accounts.length : 0} unlocked account(s), but the oracle signs with account #${LOCAL_ORACLE_ACCOUNT_INDEX} ` +
            "(a Hardhat node has 20). Use the Hardhat node, or set ORACLE_PRIVATE_KEY.",
        );
      }
      signer = await ask(() => rpc.getSigner(LOCAL_ORACLE_ACCOUNT_INDEX));
      signerSource = `local account #${LOCAL_ORACLE_ACCOUNT_INDEX}`;
    }
    const signerAddress = await signer.getAddress();

    // 5: the role. These are also the first calls into the contract, so they show whether the code at
    // the address is the registry at all.
    const contract = new Contract(target.address, contractInterface, rpc);
    let holdsRole;
    let totalLots;
    try {
      const role = await ask(() => contract.ORACLE_ROLE());
      holdsRole = await ask(() => contract.hasRole(role, signerAddress));
      totalLots = toSafeNumber(await ask(() => contract.totalBatches()), "the number of lots");
    } catch (error) {
      if (error instanceof OracleError) throw error;
      throw new PreflightError(
        "code",
        `The contract at ${target.address} does not answer like a ProvenanceRegistry (${describeFailure(error, scrub)}). ` +
          `Check ${target.addressSource}; on the local node, re-run "npm run deploy:local".`,
        { cause: error },
      );
    }
    if (!holdsRole) {
      throw new PreflightError(
        "role",
        `${signerAddress} (${signerSource}) does not hold ORACLE_ROLE on the registry at ${target.address}.\n` +
          "The regulator grants it: in the repository root run " +
          (local
            ? `"npm run roles:local", which grants it to the local node's account #${LOCAL_ORACLE_ACCOUNT_INDEX}.`
            : `"npm run roles:amoy" with ORACLE_ADDRESS=${signerAddress}.`),
      );
    }

    const warnings = [];
    const balance = await ask(() => rpc.getBalance(signerAddress));
    if (balance === 0n) {
      warnings.push(`the oracle account ${signerAddress} has a zero balance and cannot pay for gas${local ? "" : "; fund it from a faucet for this test network"}`);
    }

    return new RegistryClient({
      provider: rpc,
      contract,
      contractInterface,
      signer,
      sleep,
      scrub,
      receiptTimeoutMs,
      info: Object.freeze({
        network: config.network,
        chainId: reported,
        address: target.address,
        addressSource: target.addressSource,
        deployBlock: target.deployBlock,
        signerAddress,
        signerSource,
        totalLots,
        warnings: Object.freeze(warnings),
      }),
    });
  } catch (error) {
    // Only a provider created here is closed here; an injected one belongs to the caller.
    if (provider === undefined) rpc.destroy();
    if (error instanceof OracleError) throw error;
    // Anything else is an answer the checks did not expect (for example a node that does not
    // implement a method). It is still a failed pre-flight, and is reported as one.
    throw new PreflightError("rpc", `The JSON-RPC endpoint ${endpoint} gave an unexpected answer during the pre-flight checks (${describeFailure(error, scrub)}).`, {
      cause: error,
    });
  }
}

/** A connected, pre-flight-checked client of one ProvenanceRegistry. Create it with connectRegistry(). */
export class RegistryClient {
  #provider;
  #contract;
  #interface;
  #signer;
  #sleep;
  #scrub;
  #receiptTimeoutMs;
  /** Account nonce -> hashes of the transactions broadcast with it. Lets a retry find out whether an earlier attempt was mined. */
  #broadcasts = new Map();

  /**
   * @param {object} parts assembled by connectRegistry()
   * @param {JsonRpcProvider} parts.provider
   * @param {Contract} parts.contract
   * @param {Interface} parts.contractInterface
   * @param {import("ethers").Signer} parts.signer
   * @param {(ms: number) => Promise<void>} parts.sleep
   * @param {(text: string) => string} parts.scrub
   * @param {number} parts.receiptTimeoutMs
   * @param {RegistryInfo} parts.info
   */
  constructor({ provider, contract, contractInterface, signer, sleep, scrub, receiptTimeoutMs, info }) {
    this.#provider = provider;
    this.#contract = contract;
    this.#interface = contractInterface;
    this.#signer = signer;
    this.#sleep = sleep;
    this.#scrub = scrub;
    this.#receiptTimeoutMs = receiptTimeoutMs;
    /** What the pre-flight found. */
    this.info = info;
    /** Chain id the registry is on; written into every sensor log. */
    this.chainId = info.chainId;
    /** Registry address (checksummed); written into every sensor log. */
    this.address = info.address;
    /** Address of the account that signs the oracle's transactions. */
    this.signerAddress = info.signerAddress;
  }

  /**
   * Number of lots registered so far. Lot ids run from 1 to this number.
   * @returns {Promise<number>}
   */
  async totalLots() {
    try {
      return toSafeNumber(await this.#contract.totalBatches(), "the number of lots");
    } catch (error) {
      throw this.#failure(error, "Reading the number of lots");
    }
  }

  /**
   * Read a lot's on-chain record (verifyBatch).
   * @param {number} lotId
   * @returns {Promise<Lot>}
   * @throws {LotNotFoundError} when the registry has no such lot
   */
  async readLot(lotId) {
    let batch;
    try {
      batch = await this.#contract.verifyBatch(lotId);
    } catch (error) {
      const failure = this.#failure(error, `Reading lot ${lotId}`);
      throw failure instanceof ContractRevertError && failure.errorName === "BatchNotFound" ? new LotNotFoundError(lotId) : failure;
    }
    const status = Number(batch.status);
    return {
      id: toSafeNumber(batch.id, "a lot id"),
      status,
      statusName: statusName(status),
      active: isActiveStatus(status),
      range: { minTenthsC: Number(batch.minTempTenthsC), maxTenthsC: Number(batch.maxTempTenthsC) },
      sensorLogCount: Number(batch.sensorLogCount),
      latestSensorLog: { cid: batch.latestSensorLog.cid, contentHash: batch.latestSensorLog.contentHash },
      registeredAt: toSafeNumber(batch.registeredAt, "a registration time"),
      custodian: batch.custodian,
    };
  }

  /**
   * The chain's clock: the timestamp of the latest block.
   *
   * The contract compares a reading's time with block.timestamp, and block
   * timestamps never decrease, so a reading that is not later than this
   * value is accepted by every future block.
   *
   * With `atLeast`, the caller says which time it needs the chain to have
   * reached (the time of its newest reading). If the head is older:
   *   - on a public chain the next blocks are awaited for a few seconds;
   *   - on a local development node (chain id 31337), which mines a block
   *     only when it receives a transaction and so may show a head that is
   *     minutes old, the node is asked to mine one empty block (evm_mine).
   *     This is never attempted on any other chain id.
   * The head time is returned either way; the caller must still compare.
   *
   * @param {{ atLeast?: number }} [options]
   * @returns {Promise<number>} Unix seconds
   */
  async chainTime({ atLeast } = {}) {
    try {
      let head = await this.#headTime();
      if (atLeast === undefined || head >= atLeast) return head;

      if (this.chainId === LOCAL_CHAIN_ID) {
        try {
          await this.#provider.send("evm_mine", []);
        } catch (error) {
          // A local node without this development method: fall through and report the head as it is.
          if (isTransientFailure(error)) throw error;
        }
        return await this.#headTime();
      }

      for (let waited = 0; head < atLeast && waited < HEAD_WAIT_MS; waited += 1000) {
        await this.#sleep(1000);
        head = await this.#headTime();
      }
      return head;
    } catch (error) {
      throw this.#failure(error, "Reading the chain time");
    }
  }

  /**
   * Reserve the account nonce for one transaction: the number of transactions
   * the oracle account has sent, counting those still waiting to be mined.
   * The runner calls it once per document and passes the result to every
   * attempt for that document.
   * @returns {Promise<number>}
   */
  async reserveNonce() {
    try {
      return await this.#provider.getTransactionCount(this.signerAddress, "pending");
    } catch (error) {
      throw this.#failure(error, "Reading the account nonce");
    }
  }

  /**
   * Anchor a sensor log (anchorSensorLog). One attempt.
   * @param {number} lotId
   * @param {DocumentRef} sensorLog
   * @param {{ nonce: number }} options the nonce from reserveNonce()
   * @returns {Promise<Submission>}
   */
  async anchorSensorLog(lotId, sensorLog, { nonce }) {
    return this.#submit(`Anchoring a sensor log for lot ${lotId}`, "anchorSensorLog", [lotId, toDocumentRef(sensorLog)], nonce);
  }

  /**
   * Report a temperature excursion (reportExcursion). One attempt. On success the lot is Compromised.
   * @param {number} lotId
   * @param {{ tenthsC: number, t: number }} reading the out-of-range reading and when it was taken
   * @param {DocumentRef} sensorLog the log that contains the reading
   * @param {{ nonce: number }} options the nonce from reserveNonce()
   * @returns {Promise<Submission>}
   */
  async reportExcursion(lotId, reading, sensorLog, { nonce }) {
    return this.#submit(`Reporting an excursion for lot ${lotId}`, "reportExcursion", [lotId, reading.tenthsC, reading.t, toDocumentRef(sensorLog)], nonce);
  }

  /**
   * Release the connection so the process can exit.
   * @returns {Promise<void>}
   */
  async close() {
    this.#provider.destroy();
  }

  /**
   * Timestamp of the latest block.
   * @returns {Promise<number>}
   */
  async #headTime() {
    const block = await this.#provider.send("eth_getBlockByNumber", ["latest", false]);
    if (block === null || block === undefined) {
      throw new ChainError("The node returned no latest block.");
    }
    return toSafeNumber(BigInt(block.timestamp), "a block timestamp");
  }

  /**
   * Simulate, broadcast and confirm one contract call. See the header for the three steps.
   * @param {string} action what is being done, for error messages
   * @param {string} method contract function name
   * @param {unknown[]} args its arguments
   * @param {number} nonce the reserved account nonce
   * @returns {Promise<Submission>}
   */
  async #submit(action, method, args, nonce) {
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      throw new TypeError(`${action}: a reserved account nonce is required (got ${String(nonce)}).`);
    }
    try {
      const call = { to: this.address, from: this.signerAddress, data: this.#interface.encodeFunctionData(method, args) };

      // An earlier attempt with this nonce may have been mined although its confirmation never arrived.
      const earlier = await this.#findReceipt(nonce);
      if (earlier !== null) return await this.#outcome(earlier, call, nonce);

      // Simulate. The nonce is left out: the question is whether the contract accepts the call.
      const estimate = await this.#provider.estimateGas(call);

      await this.#broadcast({ to: call.to, data: call.data, nonce, gasLimit: (estimate * GAS_MARGIN_PERCENT) / 100n }, nonce);
      return await this.#outcome(await this.#waitForReceipt(nonce), call, nonce);
    } catch (error) {
      throw this.#failure(error, action);
    }
  }

  /**
   * Send one transaction and remember its hash under its nonce.
   * @param {{ to: string, data: string, nonce: number, gasLimit: bigint }} request
   * @param {number} nonce
   * @returns {Promise<void>}
   * @throws {NonceConsumedError} the nonce is spent and none of our attempts with it was mined
   */
  async #broadcast(request, nonce) {
    const hashes = this.#hashesFor(nonce);
    try {
      if (this.#signer instanceof Wallet) {
        // Signed locally, so the hash is known BEFORE the transaction leaves: if the node's answer is
        // lost, the next attempt can still look the transaction up.
        const signed = await this.#signer.signTransaction(await this.#signer.populateTransaction(request));
        hashes.add(keccak256(signed));
        await this.#provider.send("eth_sendRawTransaction", [signed]);
      } else {
        // The node signs with its unlocked account (local development node only) and returns the hash.
        hashes.add(await this.#signer.sendUncheckedTransaction(request));
      }
    } catch (error) {
      if (error?.code === "NONCE_EXPIRED") {
        // The nonce is spent. If one of our own attempts spent it, that is success, not an error.
        if ((await this.#findReceipt(nonce)) !== null) return;
        throw new NonceConsumedError(nonce, { cause: error });
      }
      // The node already holds a transaction with this nonce. When it is one of ours, wait for it.
      if (isAlreadyPending(error) && hashes.size > 0) return;
      throw error;
    }
  }

  /**
   * Poll until one of the transactions broadcast with a nonce is mined.
   * @param {number} nonce
   * @returns {Promise<import("ethers").TransactionReceipt>}
   * @throws {TransientChainError} when none is mined in time; carries the latest transaction hash
   */
  async #waitForReceipt(nonce) {
    let pause = 100;
    for (let waited = 0; ; waited += pause, pause = Math.min(pause * 2, 2000)) {
      const receipt = await this.#findReceipt(nonce);
      if (receipt !== null) return receipt;
      if (waited >= this.#receiptTimeoutMs) {
        const txHash = [...this.#hashesFor(nonce)].at(-1) ?? null;
        throw new TransientChainError(
          `The transaction ${txHash ?? "(hash unknown)"} was not mined within ${Math.round(this.#receiptTimeoutMs / 1000)} s; its outcome is still open.`,
          { txHash },
        );
      }
      await this.#sleep(pause);
    }
  }

  /**
   * Look for a receipt of any transaction broadcast with a nonce.
   * @param {number} nonce
   * @returns {Promise<import("ethers").TransactionReceipt|null>}
   */
  async #findReceipt(nonce) {
    for (const hash of this.#broadcasts.get(nonce) ?? []) {
      const receipt = await this.#provider.getTransactionReceipt(hash);
      if (receipt !== null) return receipt;
    }
    return null;
  }

  /**
   * The set of transaction hashes broadcast with a nonce, created on first use.
   * @param {number} nonce
   * @returns {Set<string>}
   */
  #hashesFor(nonce) {
    let hashes = this.#broadcasts.get(nonce);
    if (hashes === undefined) {
      hashes = new Set();
      this.#broadcasts.set(nonce, hashes);
      // Bounded memory for a long-running monitor: a Map keeps insertion order, so the first key is the oldest.
      if (this.#broadcasts.size > REMEMBERED_NONCES) {
        this.#broadcasts.delete(this.#broadcasts.keys().next().value);
      }
    }
    return hashes;
  }

  /**
   * Turn a receipt into the result of a submission.
   * @param {import("ethers").TransactionReceipt} receipt
   * @param {{ to: string, from: string, data: string }} call the call that was sent, to explain a failure
   * @param {number} nonce
   * @returns {Promise<Submission>}
   * @throws {ContractRevertError} when the transaction was mined but reverted
   */
  async #outcome(receipt, call, nonce) {
    if (receipt.status !== 1) {
      // Mined but reverted: the state changed between the simulation and the block (for example the
      // lot was recalled in between). Replaying the call against the new state names the reason.
      let replayed = null;
      try {
        await this.#provider.call(call);
      } catch (error) {
        replayed = decodeRevert(error, this.#interface);
      }
      throw replayed ?? new ContractRevertError({ errorName: "unknown", detail: `transaction ${receipt.hash} was mined in block ${receipt.blockNumber} but reverted` });
    }
    this.#broadcasts.delete(nonce);

    let logIndex = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.address.toLowerCase()) continue;
      const event = this.#interface.parseLog(log);
      if (event !== null && (event.name === "SensorLogAnchored" || event.name === "ExcursionReported")) {
        logIndex = Number(event.args.logIndex);
      }
    }
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber, logIndex };
  }

  /**
   * Convert anything thrown by ethers into one of this package's typed errors.
   * @param {unknown} error
   * @param {string} action what was being done, for the message
   * @returns {OracleError}
   */
  #failure(error, action) {
    if (error instanceof OracleError) return error;

    const reason = describeFailure(error, this.#scrub);
    // Checked before the revert decoding: a node's own refusal of eth_call or eth_estimateGas
    // looks like a revert without data to ethers (see isNodeRefusal).
    if (isTransientFailure(error) || isAlreadyPending(error)) {
      return new TransientChainError(`${action} failed: ${reason}.`, { cause: error });
    }
    if (isNodeRefusal(error)) {
      return new ChainError(`${action} failed: ${reason}.`, { cause: error });
    }

    const revert = decodeRevert(error, this.#interface);
    if (revert !== null) return revert;

    if (/** @type {any} */ (error)?.code === "INSUFFICIENT_FUNDS") {
      return new ChainError(`${action} failed: the oracle account ${this.signerAddress} cannot pay for gas. Fund it (on a test network, from a faucet).`, {
        code: "INSUFFICIENT_FUNDS",
        cause: error,
      });
    }
    return new ChainError(`${action} failed: ${reason}.`, { cause: error });
  }
}

/**
 * Convert an on-chain integer to a JavaScript number, refusing values that would lose precision.
 * @param {bigint|number} value
 * @param {string} what for the error message
 * @returns {number}
 * @throws {ChainError}
 */
function toSafeNumber(value, what) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new ChainError(`The chain returned ${what} that is too large to handle (${String(value)}).`);
  }
  return number;
}

/**
 * The DocumentRef struct as the ABI encoder expects it.
 * @param {DocumentRef} ref
 * @returns {{ cid: string, contentHash: string }}
 */
function toDocumentRef(ref) {
  return { cid: ref.cid, contentHash: ref.contentHash };
}
