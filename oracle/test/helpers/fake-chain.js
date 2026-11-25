/**
 * FakeChain: a JSON-RPC endpoint in memory, for testing the REAL registry
 * client (src/oracle/registryClient.js) without a node and without a socket.
 *
 * The client talks to an ethers JsonRpcProvider. FakeChain supplies a
 * provider whose transport is replaced by a function call, so every request
 * the client makes passes through ethers' real encoding, decoding and error
 * mapping, and is then answered by the small state machine below.
 *
 * The state machine implements the part of ProvenanceRegistry the oracle
 * uses, with the committed ABI: role lookup, verifyBatch, totalBatches,
 * anchorSensorLog and reportExcursion, including their custom errors and
 * events. It is not an EVM; it is the minimum that makes the client's
 * requests meaningful, written from the interface in
 * contracts/interfaces/IProvenanceRegistry.sol.
 *
 * Failures can be scripted per JSON-RPC method: an RPC error object, a
 * transport error, or "apply the request, then lose the answer".
 */

import { Interface, JsonRpcProvider, Network, Transaction, getAddress, id, keccak256, toBeHex, toQuantity } from "ethers";

const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const ZERO_HASH = `0x${"00".repeat(32)}`;
const ORACLE_ROLE = id("ORACLE_ROLE");
const STATUS_COMPROMISED = 4;

/**
 * An error that stands for a broken connection.
 * @param {string} [code] a Node.js socket error code
 * @returns {Error}
 */
export function transportError(code = "ECONNRESET") {
  return Object.assign(new Error(`socket hang up (${code})`), { code });
}

/** The provider handed to the client: a JsonRpcProvider whose requests go to a FakeChain. */
class FakeRpcProvider extends JsonRpcProvider {
  #chain;

  /**
   * @param {FakeChain} chain
   * @param {string} networkName
   * @param {number} expectedChainId the chain id the CLIENT expects (the fake may answer with another one)
   */
  constructor(chain, networkName, expectedChainId) {
    const network = new Network(networkName, expectedChainId);
    // The URL is never contacted: _send below replaces the transport.
    super("http://fake-rpc.invalid", network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 });
    this.#chain = chain;
  }

  /**
   * @param {object|object[]} payload one JSON-RPC request, or a batch
   * @returns {Promise<object[]>} the responses
   */
  async _send(payload) {
    const answers = [];
    for (const request of Array.isArray(payload) ? payload : [payload]) {
      answers.push(await this.#chain.answer(request));
    }
    return answers;
  }
}

/** An in-memory chain with one ProvenanceRegistry. */
export class FakeChain {
  /**
   * @param {object} options
   * @param {object[]} options.abi          the registry ABI
   * @param {number} [options.chainId]      chain id the node reports
   * @param {string} [options.registry]     address that holds the registry
   * @param {string[]} [options.accounts]   unlocked accounts (eth_accounts)
   * @param {string[]} [options.oracles]    accounts that hold ORACLE_ROLE
   * @param {number} [options.time]         timestamp of the latest block
   * @param {() => number} [options.wallClock] the node's clock: a new block gets max(latest + 1, wallClock())
   * @param {boolean} [options.development] whether evm_mine exists (a Hardhat-like node)
   */
  constructor({ abi, chainId = 31337, registry = "0x5FbDB2315678afecb367f032d93F642f64180aa3", accounts = [], oracles = [], time = 1_794_300_000, wallClock, development = true }) {
    this.interface = new Interface(abi);
    this.chainId = chainId;
    this.registry = getAddress(registry);
    this.accounts = accounts.map((account) => getAddress(account));
    this.oracles = new Set(oracles.map((account) => getAddress(account)));
    this.time = time;
    this.wallClock = wallClock ?? (() => this.time + 1);
    this.development = development;
    this.blockNumber = 10;
    /** Addresses with contract code. Remove the registry from it to model a restarted node. */
    this.code = new Map([[this.registry, "0x6080604052"]]);
    /** @type {Map<number, object>} */
    this.lots = new Map();
    /** @type {Map<string, number>} account -> next nonce */
    this.nonces = new Map();
    /** @type {Map<string, object>} transaction hash -> receipt */
    this.receipts = new Map();
    /** Every request received: { method, params }. */
    this.requests = [];
    /** @type {{ method: string, respond: (params: any[], handle: () => any) => any }[]} */
    this.scripts = [];
    this.balance = 10n ** 18n;
  }

  /**
   * A provider connected to this chain.
   * @param {{ networkName?: string, expectedChainId?: number }} [options]
   * @returns {JsonRpcProvider}
   */
  provider({ networkName = "localhost", expectedChainId = this.chainId } = {}) {
    return new FakeRpcProvider(this, networkName, expectedChainId);
  }

  /**
   * Register a lot.
   * @param {{ status?: number, minTenthsC?: number, maxTenthsC?: number }} [lot]
   * @returns {number} its id
   */
  addLot({ status = 2, minTenthsC = 20, maxTenthsC = 80 } = {}) {
    const lotId = this.lots.size + 1;
    this.lots.set(lotId, { id: lotId, status, minTenthsC, maxTenthsC, sensorLogCount: 0, latest: { cid: "", contentHash: ZERO_HASH }, registeredAt: this.time });
    return lotId;
  }

  /**
   * Script the next request(s) of a JSON-RPC method.
   * @param {string} method
   * @param {object} script exactly one of:
   *   `rpcError`      answer with this JSON-RPC error object { code, message, data? }
   *   `transport`     fail with this Error instead of answering
   *   `loseResponse`  process the request normally, then fail with a transport error
   *   `result`        answer with this value instead of the real one; a function receives
   *                   (params, handle) and may call handle() to obtain and alter the real answer
   * @param {number} [times]
   */
  script(method, options, times = 1) {
    const { rpcError, transport, loseResponse } = options;
    const respond = (params, handle) => {
      if (rpcError) throw Object.assign(new Error(rpcError.message), { rpcError });
      if (transport) throw transport;
      if (loseResponse) {
        handle();
        throw transportError();
      }
      // "in", because a scripted result may be null (a receipt that is not available yet).
      if ("result" in options) return typeof options.result === "function" ? options.result(params, handle) : options.result;
      return handle();
    };
    for (let i = 0; i < times; i++) this.scripts.push({ method, respond });
  }

  /** Number of requests received for a method. @param {string} method */
  count(method) {
    return this.requests.filter((request) => request.method === method).length;
  }

  /**
   * Answer one JSON-RPC request.
   * @param {{ id: number, method: string, params: any[] }} request
   * @returns {Promise<object>} the JSON-RPC response object
   */
  async answer({ id: requestId, method, params }) {
    this.requests.push({ method, params });
    const handle = () => {
      const handler = this.#handlers()[method];
      if (handler === undefined) {
        throw Object.assign(new Error("unsupported"), { rpcError: { code: -32601, message: `the method ${method} does not exist/is not available` } });
      }
      return handler(params);
    };
    try {
      const index = this.scripts.findIndex((script) => script.method === method);
      const result = index === -1 ? handle() : this.scripts.splice(index, 1)[0].respond(params, handle);
      return { jsonrpc: "2.0", id: requestId, result };
    } catch (error) {
      if (error.rpcError) return { jsonrpc: "2.0", id: requestId, error: error.rpcError };
      throw error;
    }
  }

  /** The JSON-RPC methods this chain implements. */
  #handlers() {
    return {
      eth_chainId: () => toQuantity(this.chainId),
      eth_accounts: () => this.accounts,
      eth_getCode: ([address]) => this.code.get(getAddress(address)) ?? "0x",
      eth_getBalance: () => toQuantity(this.balance),
      eth_gasPrice: () => toQuantity(2_000_000_000),
      eth_maxPriorityFeePerGas: () => toQuantity(1_000_000_000),
      eth_getTransactionCount: ([address]) => toQuantity(this.nonces.get(getAddress(address)) ?? 0),
      eth_getBlockByNumber: () => this.#block(),
      eth_call: ([call]) => this.#execute(call, { commit: false }).returnData,
      eth_estimateGas: ([call]) => {
        this.#execute(call, { commit: false });
        return toQuantity(90_000);
      },
      eth_sendTransaction: ([transaction]) => this.#mine(transaction, keccak256(toBeHex(this.receipts.size + 1, 32))),
      eth_sendRawTransaction: ([raw]) => {
        const transaction = Transaction.from(raw);
        return this.#mine({ from: transaction.from, to: transaction.to, data: transaction.data, nonce: toQuantity(transaction.nonce) }, keccak256(raw));
      },
      eth_getTransactionReceipt: ([hash]) => this.receipts.get(hash) ?? null,
      ...(this.development
        ? {
            evm_mine: () => {
              this.#newBlock();
              return "0x0";
            },
          }
        : {}),
    };
  }

  /** Start a new block: the number goes up and the timestamp follows the node's clock, never backwards. */
  #newBlock() {
    this.blockNumber += 1;
    this.time = Math.max(this.time + 1, this.wallClock());
  }

  /** The latest block in the JSON-RPC encoding ethers expects. */
  #block() {
    return {
      number: toQuantity(this.blockNumber),
      hash: keccak256(toBeHex(this.blockNumber, 32)),
      parentHash: keccak256(toBeHex(this.blockNumber - 1, 32)),
      timestamp: toQuantity(this.time),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      gasLimit: toQuantity(30_000_000),
      gasUsed: "0x0",
      miner: ZERO_ADDRESS,
      extraData: "0x",
      baseFeePerGas: toQuantity(1_000_000_000),
      transactions: [],
    };
  }

  /**
   * Include a transaction in a new block.
   * @param {{ from: string, to: string, data: string, nonce?: string }} transaction
   * @param {string} hash
   * @returns {string} the transaction hash
   */
  #mine(transaction, hash) {
    const from = getAddress(transaction.from);
    const expected = this.nonces.get(from) ?? 0;
    if (transaction.nonce !== undefined && Number(BigInt(transaction.nonce)) < expected) {
      throw Object.assign(new Error("nonce"), { rpcError: { code: -32000, message: `Nonce too low. Expected nonce to be ${expected} but got ${Number(BigInt(transaction.nonce))}.` } });
    }
    this.#newBlock();
    const { logs } = this.#execute(transaction, { commit: true });
    this.nonces.set(from, expected + 1);
    const blockHash = keccak256(toBeHex(this.blockNumber, 32));
    this.receipts.set(hash, {
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash,
      blockNumber: toQuantity(this.blockNumber),
      from,
      to: this.registry,
      contractAddress: null,
      cumulativeGasUsed: toQuantity(80_000),
      gasUsed: toQuantity(80_000),
      effectiveGasPrice: toQuantity(2_000_000_000),
      logsBloom: `0x${"00".repeat(256)}`,
      status: "0x1",
      type: "0x2",
      logs: logs.map((log, index) => ({ ...log, address: this.registry, blockHash, blockNumber: toQuantity(this.blockNumber), transactionHash: hash, transactionIndex: "0x0", logIndex: toQuantity(index), removed: false })),
    });
    return hash;
  }

  /**
   * Run a call against the registry.
   * @param {{ from?: string, to: string, data: string }} call
   * @param {{ commit: boolean }} options commit = false executes without changing state
   * @returns {{ returnData: string, logs: { topics: string[], data: string }[] }}
   * @throws an error carrying a JSON-RPC revert answer
   */
  #execute(call, { commit }) {
    const contract = this.interface;
    const fail = (name, args) => {
      throw Object.assign(new Error(name), { rpcError: { code: 3, message: `execution reverted: custom error ${name}`, data: contract.encodeErrorResult(name, args) } });
    };
    if (getAddress(call.to) !== this.registry || !this.code.has(this.registry)) {
      // A call to an address without code succeeds with empty return data.
      return { returnData: "0x", logs: [] };
    }
    const invocation = contract.parseTransaction({ data: call.data });
    const result = (values) => contract.encodeFunctionResult(invocation.name, values);
    // During estimation and calls the pending block's time applies, as on a real node.
    const blockTime = commit ? this.time : Math.max(this.time + 1, this.wallClock());

    switch (invocation.name) {
      case "ORACLE_ROLE":
        return { returnData: result([ORACLE_ROLE]), logs: [] };
      case "hasRole":
        return { returnData: result([invocation.args[0] === ORACLE_ROLE && this.oracles.has(getAddress(invocation.args[1]))]), logs: [] };
      case "totalBatches":
        return { returnData: result([this.lots.size]), logs: [] };
      case "verifyBatch": {
        const lot = this.lots.get(Number(invocation.args[0]));
        if (lot === undefined) fail("BatchNotFound", [invocation.args[0]]);
        const empty = { cid: "", contentHash: ZERO_HASH };
        return {
          returnData: result([
            {
              id: lot.id,
              productHash: id(`product-${lot.id}`),
              manufacturer: ZERO_ADDRESS,
              manufactureDate: lot.registeredAt - 86400,
              registeredAt: lot.registeredAt,
              custodian: ZERO_ADDRESS,
              pendingCustodian: ZERO_ADDRESS,
              status: lot.status,
              minTempTenthsC: lot.minTenthsC,
              maxTempTenthsC: lot.maxTenthsC,
              sensorLogCount: lot.sensorLogCount,
              metadata: { cid: "bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4", contentHash: id("metadata") },
              certificate: empty,
              latestSensorLog: lot.latest,
            },
          ]),
          logs: [],
        };
      }
      case "anchorSensorLog":
      case "reportExcursion": {
        const sender = getAddress(call.from ?? ZERO_ADDRESS);
        if (!this.oracles.has(sender)) fail("AccessControlUnauthorizedAccount", [sender, ORACLE_ROLE]);
        const report = invocation.name === "reportExcursion";
        const lotId = Number(invocation.args[0]);
        const reference = invocation.args[report ? 3 : 1];
        const lot = this.lots.get(lotId);
        if (lot === undefined) fail("BatchNotFound", [lotId]);
        if (lot.status > 2) fail("InvalidStatus", [lotId, lot.status]);
        if (report) {
          const [, reading, observedAt] = invocation.args;
          if (observedAt === 0n || observedAt > BigInt(blockTime)) fail("InvalidTimestamp", [observedAt]);
          if (reading >= BigInt(lot.minTenthsC) && reading <= BigInt(lot.maxTenthsC)) fail("ReadingWithinRange", [reading, lot.minTenthsC, lot.maxTenthsC]);
        }
        if (reference.cid === "" || reference.contentHash === ZERO_HASH) fail("EmptyDocument", []);
        if (!commit) return { returnData: "0x", logs: [] };

        lot.sensorLogCount += 1;
        lot.latest = { cid: reference.cid, contentHash: reference.contentHash };
        if (report) lot.status = STATUS_COMPROMISED;
        const event = report
          ? contract.encodeEventLog("ExcursionReported", [lotId, lot.sensorLogCount, invocation.args[1], invocation.args[2], reference.cid, reference.contentHash])
          : contract.encodeEventLog("SensorLogAnchored", [lotId, lot.sensorLogCount, reference.cid, reference.contentHash]);
        return { returnData: "0x", logs: [event] };
      }
      default:
        throw Object.assign(new Error("revert"), { rpcError: { code: 3, message: "execution reverted", data: "0x" } });
    }
  }
}

/**
 * A synthetic private key for tests, assembled at run time from a repeated
 * pattern so that no key-shaped literal exists in the repository. It
 * controls nothing on any network.
 * @param {string} pattern two hex digits
 * @returns {string} "0x" + 64 hex digits
 */
export function syntheticKey(pattern = "5e") {
  return `0x${pattern.repeat(32)}`;
}
