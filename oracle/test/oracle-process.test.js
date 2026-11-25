/**
 * Process-level tests of the oracle: the real executable (src/oracle/main.js)
 * is started as a child process and talks JSON-RPC over HTTP, exactly as it
 * does in a demo.
 *
 * The other end of the HTTP connection is NOT a blockchain node. It is the
 * in-memory FakeChain (test/helpers/fake-chain.js) behind a throw-away HTTP
 * server on an ephemeral port. What these tests add to the in-process ones is
 * the wiring that only a real process has: environment variables, the HTTP
 * transport of ethers, the files written to the store directory, signals and
 * exit codes. Whether the oracle works against the actual contract on a
 * Hardhat node is a separate end-to-end test, which needs a deployed registry.
 *
 * The registry address is given with REGISTRY_ADDRESS, so the tests do not
 * depend on a deployments/localhost.json being present, and the RPC URL is
 * always the mock server, so no other port is ever contacted.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { createDocuments } from "../src/documents/index.js";
import { computeContentHash } from "../src/ipfs/index.js";
import { FakeChain } from "./helpers/fake-chain.js";
import { startMockServer, temporaryDirectory } from "./helpers/harness.js";

const MAIN = fileURLToPath(new URL("../src/oracle/main.js", import.meta.url));
/** Twenty synthetic unlocked accounts; number 4 is the oracle, as on the local Hardhat node after "npm run roles:local". */
const ACCOUNTS = Array.from({ length: 20 }, (_, index) => `0x${(index + 1).toString(16).padStart(2, "0").repeat(20)}`);

/** @type {object[]} the committed registry ABI */
let ABI;
before(async () => {
  ABI = JSON.parse(await readFile(loadConfig({}).paths.abiFile, "utf8"));
});

/**
 * Start a FakeChain behind HTTP and return what a child process needs to reach it.
 * The chain's clock is the real one and its latest block is ten minutes old,
 * like a local development node that has been idle.
 * `beforeAnswer` runs before each request is answered, so a test can hold a step in flight.
 */
async function node(t, chainOptions = {}, beforeAnswer = async () => {}) {
  const wallClock = () => Math.floor(Date.now() / 1000);
  const chain = new FakeChain({ abi: ABI, accounts: ACCOUNTS, oracles: [ACCOUNTS[4]], time: wallClock() - 600, wallClock, ...chainOptions });
  const server = await startMockServer(t, async (request, response) => {
    const rpcRequest = JSON.parse(request.body.toString("utf8"));
    await beforeAnswer(rpcRequest);
    const answer = await chain.answer(rpcRequest);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(answer));
  });
  const store = await temporaryDirectory(t);
  const env = { PATH: process.env.PATH, RPC_URL: server.url, REGISTRY_ADDRESS: chain.registry, IPFS_LOCAL_DIR: store };
  return { chain, server, store, env };
}

/**
 * Run the executable and collect its output.
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {(child: import("node:child_process").ChildProcess, output: { stdout: string }) => void} [onOutput] called on every stdout chunk
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, lines: string[] }>}
 */
function execute(args, env, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    const output = { stdout: "", stderr: "" };
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.stdout.on("data", (chunk) => {
      output.stdout += chunk;
      onOutput?.(child, output);
    });
    child.stderr.on("data", (chunk) => (output.stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ...output, lines: output.stdout.split("\n").filter(Boolean) });
    });
  });
}

describe("the oracle as a process, over HTTP JSON-RPC", () => {
  test("check: the pre-flight passes and nothing is sent", async (t) => {
    const { chain, env } = await node(t);
    chain.addLot();
    const run = await execute(["check"], env);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.lines.length, 1);
    assert.match(run.lines[0], new RegExp(`oracle {2}READY {5}network=localhost chainId=31337 registry=${chain.registry} signer=${ACCOUNTS[4]} via="local account #4" lots=1 storage=local$`, "i"));
    assert.equal(chain.receipts.size, 0);
    assert.equal(run.stderr, "");
  });

  test("once: the excursion is reported, and the stored file is the one the chain references", async (t) => {
    const { chain, store, env } = await node(t);
    chain.addLot();
    const startedAt = Math.floor(Date.now() / 1000);

    const run = await execute(["once", "--lot", "1", "--scenario", "excursion"], env);

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.lines.length, 2);
    assert.match(run.lines[1], / lot 1 {3}EXCURSION log=1 readings=12 .* rule="3 consecutive readings outside 2\.0 C to 8\.0 C" cid=bafkrei[a-z2-7]{52} tx=0x[0-9a-f]{64} block=\d+ status=Compromised$/);

    const lot = chain.lots.get(1);
    assert.equal(lot.status, 4, "the lot is Compromised on the chain");
    assert.equal(lot.sensorLogCount, 1);
    assert.ok(run.lines[1].includes(`cid=${lot.latest.cid} `));

    const files = await readdir(store);
    assert.deepEqual(files, [lot.latest.cid]);
    const bytes = await readFile(path.join(store, lot.latest.cid));
    assert.equal(computeContentHash(bytes), lot.latest.contentHash);
    const { document } = createDocuments().parse(bytes, "sensor-log");
    assert.equal(document.registry, chain.registry);
    assert.equal(document.chainId, 31337);
    // The idle node's head was ten minutes old; the oracle had it mine a block, so the log ends at the present.
    assert.ok(document.endedAt >= startedAt - 20 && document.endedAt < chain.time, `log ends at ${document.endedAt}, chain time ${chain.time}`);
    assert.equal(chain.count("evm_mine"), 1);
    assert.equal(chain.count("eth_sendTransaction"), 1);
  });

  test("once on an inactive lot exits with 1 and sends nothing", async (t) => {
    const { chain, store, env } = await node(t);
    chain.addLot({ status: 5 });
    const run = await execute(["once", "--lot", "1"], env);
    assert.equal(run.code, 1);
    assert.match(run.lines[1], / lot 1 {3}SKIP {6}status=Recalled /);
    assert.equal(chain.count("eth_sendTransaction") + chain.count("eth_estimateGas"), 0);
    assert.deepEqual(await readdir(store).catch(() => []), []);
  });

  // Windows has no signals: child.kill() ends the process at once there, so the clean shutdown
  // cannot be exercised this way. The shutdown logic itself is covered in-process in runner.test.js.
  const noSignals = process.platform === "win32" ? "Windows cannot deliver SIGINT to a child process" : false;

  test("monitor: anchors logs until SIGINT, then stops cleanly with exit code 0", { skip: noSignals }, async (t) => {
    const { chain, env } = await node(t);
    chain.addLot();
    let interrupted = false;

    const run = await execute(["monitor"], { ...env, SIM_SAMPLE_SECONDS: "1", SIM_LOG_SIZE: "2" }, (child, output) => {
      // Ctrl+C as soon as the first log has been anchored.
      if (!interrupted && / ANCHOR /.test(output.stdout)) {
        interrupted = true;
        child.kill("SIGINT");
      }
    });

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.signal, null, "the process ended by itself, it was not killed by the signal");
    assert.match(run.lines[1], /oracle {2}MONITOR {3}lots=all-active scenario=normal sampleSeconds=1 logSize=2 runLength=3$/);
    assert.match(run.lines[2], / lot 1 {3}WATCH /);
    assert.match(run.lines[3], / lot 1 {3}ANCHOR {4}log=1 readings=2 /);
    assert.match(run.lines.at(-1), /oracle {2}STOPPED {3}reason=signal ticks=\d+ anchored=\d+ excursions=0 failures=0 discardedReadings=\d+$/);
    assert.ok(chain.lots.get(1).sensorLogCount >= 1);
    // A WAIT line may appear: with 1-second samples, two readings can fall in the same second, the later one
    // is stamped a second ahead, and its log waits a round for the chain's clock. Nothing else may be printed.
    assert.equal(run.stderr.replace(/^.* WAIT .*\n/gm, ""), "");
  });

  /**
   * Run the monitor and press Ctrl+C twice while its first transaction is held in flight, so the
   * process is still busy with that step when the second signal arrives.
   * @param {number} gapMs time between the two signals
   * @param {number} holdMs how long the transaction is held after the second signal
   */
  async function interruptTwice(t, gapMs, holdMs) {
    let child = null;
    let pressed = false;
    const { chain, env } = await node(t, {}, async (request) => {
      if (request.method !== "eth_sendTransaction" || pressed) return;
      pressed = true;
      child.kill("SIGINT");
      await delay(gapMs);
      child.kill("SIGINT");
      // Released early when the process is gone, so a killed child does not keep the test waiting.
      await Promise.race([delay(holdMs), new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve)))]);
    });
    chain.addLot();
    const run = await execute(["monitor"], { ...env, SIM_SAMPLE_SECONDS: "1", SIM_LOG_SIZE: "1" }, (started) => (child = started));
    return { chain, run };
  }

  // Ctrl+C on "npm run oracle" in a terminal delivers SIGINT twice within milliseconds: once from the
  // terminal to the whole process group, once forwarded by npm. Found on a real run; the copy used to
  // hit Node's default handler and kill the monitor before its summary line.
  test("monitor: one Ctrl+C delivered twice (terminal and npm) still stops cleanly", { skip: noSignals }, async (t) => {
    const { chain, run } = await interruptTwice(t, 30, 300);

    assert.equal(run.signal, null, "the copy of the signal did not kill the process");
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.lines.at(-2), / lot 1 {3}ANCHOR {4}log=1 readings=1 /, "the step in progress finished");
    assert.match(run.lines.at(-1), /oracle {2}STOPPED {3}reason=signal ticks=1 anchored=1 /);
    assert.equal(chain.lots.get(1).sensorLogCount, 1);
  });

  test("monitor: a second Ctrl+C, pressed later, ends the process at once", { skip: noSignals }, async (t) => {
    const startedAt = Date.now();
    const { run } = await interruptTwice(t, 800, 5000);

    assert.equal(run.signal, "SIGINT", "ended by the default handler of the second signal");
    assert.ok(Date.now() - startedAt < 4000, "it did not wait for the step in progress");
    assert.doesNotMatch(run.stdout, / STOPPED /);
  });

  test("a signer without ORACLE_ROLE stops the start-up with an instruction and exit code 1", async (t) => {
    const { env } = await node(t, { oracles: [] });
    const run = await execute(["monitor"], env);
    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, new RegExp(`^error: ${ACCOUNTS[4]} \\(local account #4\\) does not hold ORACLE_ROLE`, "i"));
    assert.match(run.stderr, /npm run roles:local/);
    assert.doesNotMatch(run.stderr, /\n\s+at .*\(.*\.js:\d+/, "no stack trace");
  });

  test("an endpoint on the wrong chain is refused", async (t) => {
    const { env } = await node(t, { chainId: 1337 });
    const run = await execute(["check"], env);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /^error: The JSON-RPC endpoint http:\/\/127\.0\.0\.1:\d+ is on chain id 1337, but NETWORK=localhost means chain id 31337/);
  });

  test("an unreachable endpoint is explained", async (t) => {
    const { server, env } = await node(t);
    await server.close(); // nothing listens on this port any more
    const run = await execute(["check"], env);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /^error: Cannot reach the JSON-RPC endpoint http:\/\/127\.0\.0\.1:\d+ \(.*ECONNREFUSED.*\)\.\nStart the local node with "npm run node"/);
    assert.doesNotMatch(run.stderr, /\n\s+at .*\(.*\.js:\d+/);
  });
});
