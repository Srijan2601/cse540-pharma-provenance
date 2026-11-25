/**
 * Tests for the oracle's command line (src/oracle/cli.js, format.js and the
 * executable main.js): the three commands, their --help texts, the console
 * lines, and the exit codes.
 *
 * The commands run in-process with captured output, a fake registry in place
 * of the chain, the real local IPFS backend in a temporary directory, and a
 * clock that jumps instead of waiting. A few tests start the real executable
 * as a child process, but only with arguments that end before any network
 * access (help, wrong usage, invalid configuration), so no node is needed
 * and none is contacted.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { createDocuments } from "../src/documents/index.js";
import { PreflightError } from "../src/errors.js";
import { computeContentHash, computeRawCid } from "../src/ipfs/index.js";
import { CHECK_USAGE, MONITOR_USAGE, ONCE_USAGE, ORACLE_USAGE, runOracleCli } from "../src/oracle/cli.js";
import { formatEvent, formatEventJson, isDiagnostic } from "../src/oracle/format.js";
import { connectRegistry } from "../src/oracle/registryClient.js";
import { FakeRegistry, STATUS } from "./helpers/fake-registry.js";
import { temporaryDirectory } from "./helpers/harness.js";

const MAIN = fileURLToPath(new URL("../src/oracle/main.js", import.meta.url));
const START = 1_794_300_000;
const HASH = /0x[0-9a-f]{64}/;
const CID = /bafkrei[a-z2-7]{52}/;

/**
 * A scratch setup: a fake registry, a store directory, and run(), which
 * executes one command with captured output.
 */
async function workspace(t, { registry = new FakeRegistry({ time: START }), connect } = {}) {
  const store = await temporaryDirectory(t);
  let now = START;
  let connections = 0;
  const run = async (args, { env = {}, signal, onSleep } = {}) => {
    const out = [];
    const err = [];
    const code = await runOracleCli(args, {
      env: { IPFS_LOCAL_DIR: store, ...env },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      clock: () => Math.floor(now),
      sleep: async (ms) => {
        now += ms / 1000;
        await onSleep?.(ms);
      },
      signal,
      connect:
        connect ??
        (async () => {
          connections += 1;
          return registry;
        }),
    });
    return { code, out, err, text: out.join("\n"), errors: err.join("\n") };
  };
  return { registry, store, run, connections: () => connections };
}

describe("help", () => {
  test("the general help lists the commands; no command or an unknown one is a usage error", async (t) => {
    const { run, connections } = await workspace(t);
    for (const args of [["help"], ["--help"], ["-h"]]) {
      const result = await run(args);
      assert.equal(result.code, 0);
      assert.equal(result.text, ORACLE_USAGE);
    }
    for (const word of ["monitor", "once", "check", "npm run oracle", "npm run oracle:once", "npm run oracle:check", "ORACLE_PRIVATE_KEY", "EXCURSION_RUN_LENGTH"]) {
      assert.ok(ORACLE_USAGE.includes(word), word);
    }
    assert.equal((await run([])).code, 2);
    const unknown = await run(["anchor-everything"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.errors, /^error: Unknown command "anchor-everything"\./);
    assert.match(unknown.errors, /Usage: node src\/oracle\/main\.js <command>/);
    assert.equal(connections(), 0);
  });

  test("every command has its own --help, printed without touching configuration or chain", async (t) => {
    const { run, connections } = await workspace(t);
    const cases = [
      ["monitor", MONITOR_USAGE, ["--lots <ids>", "--scenario <name>", "--scenario <lot>=<name>", "--cycles <n>", "--json", "Ctrl+C", "normal", "excursion", "freeze", "spike", "SIM_SAMPLE_SECONDS", "Exit status"]],
      ["once", ONCE_USAGE, ["--lot <id>", "--scenario <name>", "--json", "reportExcursion", "Exit status"]],
      ["check", CHECK_USAGE, ["pre-flight", "Sends no transaction"]],
    ];
    for (const [command, usage, words] of cases) {
      // An invalid environment proves that --help does not even load the configuration.
      const result = await run([command, "--help"], { env: { NETWORK: "nowhere" } });
      assert.equal(result.code, 0, command);
      assert.equal(result.text, usage);
      for (const word of words) assert.ok(usage.includes(word), `${command}: ${word}`);
      assert.equal((await run([command, "-h"])).text, usage);
    }
    assert.equal(connections(), 0);
  });
});

describe("wrong usage and failed start-up", () => {
  test("wrong arguments exit with 2, explain the problem and show the command's usage", async (t) => {
    const { run, connections } = await workspace(t);
    const cases = [
      [["once"], /--lot <id> is required/, /Usage: npm run oracle:once/],
      [["once", "--lot", "abc"], /--lot must be a whole number of at least 1 \(got "abc"\)/, /oracle:once/],
      [["once", "--lot", "0"], /--lot must be a whole number of at least 1/, /oracle:once/],
      [["once", "--lot", "1", "--scenario", "meltdown"], /Unknown scenario "meltdown"\. Scenarios: normal, excursion, freeze, spike\./, /oracle:once/],
      [["once", "--lot", "1", "extra"], /Unexpected argument/, /oracle:once/],
      [["once", "--lot", "1", "--bogus"], /Unknown option '--bogus'/, /oracle:once/],
      [["monitor", "--lots", ","], /--lots needs at least one lot id/, /Usage: npm run oracle --/],
      [["monitor", "--lots", "1,x"], /--lots must be a whole number/, /npm run oracle --/],
      [["monitor", "--cycles", "0"], /--cycles must be a whole number of at least 1/, /npm run oracle --/],
      [["monitor", "--scenario", "2=meltdown"], /Unknown scenario "meltdown"/, /npm run oracle --/],
      [["monitor", "--scenario", "two=normal"], /--scenario <lot>=<name> must be a whole number/, /npm run oracle --/],
      [["monitor", "--scenario", "spike", "--scenario", "freeze"], /names two defaults \("spike" and "freeze"\)/, /npm run oracle --/],
      [["check", "now"], /Unexpected argument/, /oracle:check/],
    ];
    for (const [args, problem, usage] of cases) {
      const result = await run(args);
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.errors, /^error: /);
      assert.match(result.errors, problem);
      assert.match(result.errors, usage);
      assert.equal(result.text, "");
    }
    assert.equal(connections(), 0, "nothing was connected for a wrong command line");
  });

  test("an invalid configuration exits with 1 before anything is connected", async (t) => {
    const { run, connections } = await workspace(t);
    const result = await run(["check"], { env: { NETWORK: "mainnet", SIM_LOG_SIZE: "0" } });
    assert.equal(result.code, 1);
    assert.match(result.errors, /^error: Invalid configuration:\n {2}- NETWORK must be one of: localhost, amoy/);
    assert.match(result.errors, /SIM_LOG_SIZE/);
    assert.equal(connections(), 0);
  });

  test("a missing deployment record produces an instruction, not a stack trace", async (t) => {
    const empty = await temporaryDirectory(t);
    // The real connectRegistry, pointed at a directory without deployment files. It fails before any network access.
    const connect = ({ config }) =>
      connectRegistry({
        config: { ...config, paths: { ...config.paths, repoRoot: empty, deploymentFile: path.join(empty, "deployments", "localhost.json"), abiFile: path.join(empty, "deployments", "abi", "ProvenanceRegistry.json") } },
      });
    const { run } = await workspace(t, { connect });
    for (const args of [["check"], ["once", "--lot", "1"], ["monitor"]]) {
      const result = await run(args);
      assert.equal(result.code, 1, args.join(" "));
      assert.match(result.errors, /^error: No deployment record at deployments.localhost\.json/);
      assert.match(result.errors, /npm run deploy:local/);
      assert.doesNotMatch(result.errors, /\n\s+at .*\.js/, "no stack trace");
      assert.equal(result.text, "");
    }
  });

  test("a failed pre-flight check exits with 1 and prints its explanation", async (t) => {
    const connect = async () => {
      throw new PreflightError("role", '0xAbc does not hold ORACLE_ROLE on the registry.\nThe regulator grants it: run "npm run roles:local".');
    };
    const { run } = await workspace(t, { connect });
    const result = await run(["monitor"]);
    assert.equal(result.code, 1);
    assert.equal(result.errors, 'error: 0xAbc does not hold ORACLE_ROLE on the registry.\nThe regulator grants it: run "npm run roles:local".');
  });
});

describe("check", () => {
  test("prints what the oracle would use and closes the connection", async (t) => {
    const { registry, run } = await workspace(t);
    registry.addLot();
    registry.info.totalLots = 1;
    const result = await run(["check"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, [
      `2026-11-10T08:40:00Z oracle  READY     network=localhost chainId=31337 registry=${registry.address} signer=${registry.signerAddress} via=fake lots=1 storage=local`,
    ]);
    assert.equal(registry.closed, true);
    assert.equal(registry.transactions.length, 0);
  });

  test("warnings from the pre-flight are shown", async (t) => {
    const { registry, run } = await workspace(t);
    registry.info.warnings = ["the oracle account has a zero balance and cannot pay for gas"];
    const result = await run(["check"]);
    assert.equal(result.out.length, 2);
    assert.match(result.out[1], /oracle {2}WARNING {3}note="the oracle account has a zero balance and cannot pay for gas"$/);
  });

  test("--json prints the same as one JSON object", async (t) => {
    const { registry, run } = await workspace(t);
    const result = await run(["check", "--json"]);
    const event = JSON.parse(result.text);
    assert.deepEqual(
      { time: event.time, at: event.at, event: event.event, network: event.network, chainId: event.chainId, address: event.address, storage: event.storage },
      { time: "2026-11-10T08:40:00Z", at: START, event: "ready", network: "localhost", chainId: 31337, address: registry.address, storage: "local" },
    );
  });
});

describe("once", () => {
  test("anchors one log and prints one line with readings, temperatures, CID and transaction", async (t) => {
    const { registry, store, run } = await workspace(t);
    registry.addLot();

    const result = await run(["once", "--lot", "1"]);

    assert.equal(result.code, 0);
    assert.equal(result.errors, "");
    assert.equal(result.out.length, 2);
    assert.match(result.out[0], /oracle {2}READY/);
    const [transaction] = registry.transactions;
    assert.match(
      result.out[1],
      new RegExp(`^2026-11-10T08:40:00Z lot 1 {3}ANCHOR {4}log=1 readings=12 min=\\d\\.\\dC max=\\d\\.\\dC cid=${transaction.cid} tx=${transaction.txHash} block=101$`),
    );

    // The CID printed on the line names a file in the store that is exactly what was anchored.
    const files = await readdir(store);
    assert.deepEqual(files, [transaction.cid]);
    const bytes = await readFile(path.join(store, transaction.cid));
    assert.equal(computeContentHash(bytes), transaction.contentHash);
    assert.equal(computeRawCid(bytes), transaction.cid);
    assert.equal(createDocuments().parse(bytes).type, "sensor-log");
    assert.equal(registry.closed, true);
  });

  test("--scenario excursion reports the excursion: the line shows the reading, its time and the rule", async (t) => {
    const { registry, run } = await workspace(t);
    registry.addLot();
    registry.addLot();

    const result = await run(["once", "--lot", "2", "--scenario", "excursion"]);

    assert.equal(result.code, 0);
    const [transaction] = registry.transactions;
    assert.equal(transaction.kind, "excursion");
    const line = result.out[1];
    assert.match(line, /^2026-11-10T08:40:00Z lot 2 {3}EXCURSION log=1 readings=12 min=\d\.\dC max=\d+\.\dC /);
    assert.ok(line.includes(`reading=${(transaction.tenthsC / 10).toFixed(1)}C observedAt=${new Date(transaction.observedAt * 1000).toISOString().replace(".000", "")} `));
    assert.ok(line.includes('rule="3 consecutive readings outside 2.0 C to 8.0 C" '));
    assert.ok(line.endsWith(`cid=${transaction.cid} tx=${transaction.txHash} block=101 status=Compromised`));
  });

  test("a spike is anchored, and the line says what was out of range and why nothing was reported", async (t) => {
    const { registry, run } = await workspace(t);
    registry.addLot();
    const result = await run(["once", "--lot", "1", "--scenario", "spike"]);
    assert.equal(result.code, 0);
    assert.match(result.out[1], /ANCHOR {4}log=1 readings=12 min=\d\.\dC max=9\.\dC outOfRange=1 longestRun=1\/3 cid=/);
  });

  test("the configuration reaches the runner: SIM_LOG_SIZE and EXCURSION_RUN_LENGTH", async (t) => {
    const { registry, run } = await workspace(t);
    registry.addLot();
    const result = await run(["once", "--lot", "1", "--scenario", "spike"], { env: { SIM_LOG_SIZE: "20", EXCURSION_RUN_LENGTH: "1" } });
    assert.equal(result.code, 0);
    assert.match(result.out[1], /EXCURSION log=1 readings=20 .*rule="1 reading outside 2\.0 C to 8\.0 C"/);
  });

  test("an inactive lot is skipped and the exit code says the log was not anchored", async (t) => {
    const { registry, run } = await workspace(t);
    registry.addLot({ status: STATUS.Recalled });
    const result = await run(["once", "--lot", "1", "--scenario", "excursion"]);
    assert.equal(result.code, 1);
    assert.match(result.out[1], /^2026-11-10T08:40:00Z lot 1 {3}SKIP {6}status=Recalled reason="the lot is Recalled, and the contract accepts sensor data only for active lots \(Created, InTransit, Stored\)"$/);
    assert.equal(registry.transactions.length, 0);
    assert.equal(registry.closed, true);
  });

  test("an unknown lot is a failure on stderr with exit code 1", async (t) => {
    const { registry, run } = await workspace(t);
    const result = await run(["once", "--lot", "5"]);
    assert.equal(result.code, 1);
    assert.equal(result.out.length, 1, "only the READY line is a result");
    assert.match(result.errors, /^2026-11-10T08:40:00Z lot 5 {3}FAILED {4}step=read-lot error="Lot 5 does not exist in the registry\."$/);
    assert.equal(registry.closed, true, "the connection is closed after a failure too");
  });

  test("--json puts exactly one object on stdout and the progress lines on stderr", async (t) => {
    const { registry, run } = await workspace(t);
    registry.addLot();
    const result = await run(["once", "--lot", "1", "--scenario", "freeze", "--json"]);
    assert.equal(result.code, 0);
    assert.equal(result.out.length, 1);
    const json = JSON.parse(result.out[0]);
    const [transaction] = registry.transactions;
    assert.deepEqual(
      { outcome: json.outcome, lotId: json.lotId, scenario: json.scenario, readings: json.readings, cid: json.cid, contentHash: json.contentHash, txHash: json.txHash, logIndex: json.logIndex, recovered: json.recovered },
      { outcome: "excursion", lotId: 1, scenario: "freeze", readings: 12, cid: transaction.cid, contentHash: transaction.contentHash, txHash: transaction.txHash, logIndex: 1, recovered: false },
    );
    assert.deepEqual(json.excursion, { t: transaction.observedAt, tenthsC: transaction.tenthsC, rule: "3 consecutive readings outside 2.0 C to 8.0 C" });
    assert.match(result.err[0], /READY/);
    assert.match(result.err[1], /EXCURSION/);

    const failed = await run(["once", "--lot", "9", "--json"]);
    assert.equal(failed.code, 1);
    assert.deepEqual(JSON.parse(failed.out[0]), { outcome: "failed", lotId: 9, step: "read-lot", consumed: false, error: "Lot 9 does not exist in the registry." });
  });
});

describe("monitor", () => {
  test("--cycles runs a fixed number of log periods and prints one line per action", async (t) => {
    const { registry, run } = await workspace(t);
    registry.addLot();
    registry.addLot();
    registry.addLot({ status: STATUS.Delivered });

    const result = await run(["monitor", "--cycles", "2", "--scenario", "2=excursion"]);

    assert.equal(result.code, 0);
    assert.equal(result.errors, "");
    const actions = result.out.map((line) => line.slice(21).split(/\s+/).slice(0, 3).join(" "));
    assert.deepEqual(actions, [
      "oracle READY network=localhost",
      "oracle MONITOR lots=all-active",
      "lot 1 WATCH",
      "lot 2 WATCH",
      "lot 3 SKIP",
      "lot 2 EXCURSION",
      "lot 2 UNWATCH",
      "lot 1 ANCHOR",
      "lot 1 ANCHOR",
      "oracle STOPPED reason=limit",
    ]);
    assert.match(result.out[1], /MONITOR {3}lots=all-active scenario=normal sampleSeconds=60 logSize=12 runLength=3$/);
    assert.match(result.out[2], /WATCH {5}status=Stored range=2\.0\.\.8\.0C scenario=normal logs=0$/);
    assert.match(result.out[3], /scenario=excursion/);
    assert.match(result.out[4], /SKIP {6}status=Delivered reason="the lot is Delivered"$/);
    assert.match(result.out[6], /UNWATCH {3}status=Compromised reason="the excursion was reported, which makes the lot Compromised"$/);
    assert.match(result.out.at(-1), /STOPPED {3}reason=limit ticks=24 anchored=2 excursions=1 failures=0 discardedReadings=0$/);
    // Every line starts with an ISO time that follows the simulated clock.
    assert.ok(result.out.every((line) => /^2026-11-10T\d\d:\d\d:\d\dZ /.test(line)));
    assert.match(result.out[7], /^2026-11-10T08:51:00Z lot 1 {3}ANCHOR/, "the first log closes with its twelfth reading, eleven minutes after the start");
    assert.equal(registry.transactions.length, 3);
    assert.equal(registry.closed, true);
  });

  test("--lots and a default --scenario select what is watched and how", async (t) => {
    const { registry, run } = await workspace(t);
    registry.addLot();
    registry.addLot();
    registry.addLot();
    const result = await run(["monitor", "--lots", "3,1", "--scenario", "spike", "--cycles", "1"]);
    assert.equal(result.code, 0);
    assert.match(result.out[1], /MONITOR {3}lots=3,1 scenario=spike/);
    assert.deepEqual(registry.transactions.map((transaction) => transaction.lotId), [3, 1]);
    assert.ok(result.out.filter((line) => / ANCHOR /.test(line)).every((line) => /outOfRange=1 longestRun=1\/3/.test(line)));
  });

  test("it stops cleanly when the signal aborts: summary line, connection closed, exit code 0", async (t) => {
    const { registry, run } = await workspace(t);
    registry.addLot();
    const shutdown = new AbortController();
    let rounds = 0;
    const result = await run(["monitor"], {
      signal: shutdown.signal,
      onSleep: () => {
        rounds += 1;
        if (rounds === 15) shutdown.abort(); // "Ctrl+C" during the wait after the fifteenth round
      },
    });
    assert.equal(result.code, 0);
    assert.match(result.out.at(-1), /STOPPED {3}reason=signal ticks=15 anchored=1 excursions=0 failures=0 discardedReadings=3$/);
    assert.equal(registry.closed, true);
    assert.equal(registry.transactions.length, 1);
  });

  test("failures of single lots go to stderr and do not change the exit code", async (t) => {
    const { registry, run } = await workspace(t);
    registry.addLot();
    registry.addLot();
    const anchor = registry.anchorSensorLog.bind(registry);
    registry.anchorSensorLog = async (lotId, ...rest) => {
      if (lotId === 1) throw new Error("lot 1 is unlucky");
      return anchor(lotId, ...rest);
    };
    const result = await run(["monitor", "--cycles", "1"]);
    assert.equal(result.code, 0);
    assert.equal(result.err.length, 1);
    assert.match(result.err[0], /lot 1 {3}FAILED {4}step=anchor error="lot 1 is unlucky" readings=12 readingsKept=false$/);
    assert.ok(result.out.some((line) => / lot 2 {3}ANCHOR /.test(line)));
    assert.match(result.out.at(-1), /failures=1/);
  });

  test("--json prints every event as one JSON object per line", async (t) => {
    const { registry, run } = await workspace(t);
    registry.addLot();
    const result = await run(["monitor", "--cycles", "1", "--json"]);
    const events = result.out.map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event), ["ready", "start", "watch", "anchor", "stop"]);
    assert.ok(events.every((event) => typeof event.time === "string" && typeof event.at === "number"));
    assert.match(events[3].cid, CID);
    assert.match(events[3].txHash, HASH);
  });
});

describe("console lines", () => {
  const at = 1_794_302_580;

  test("values with spaces, quotes or equals signs are quoted, so a line can be split back into pairs", () => {
    const line = formatEvent({ at, event: "failure", lotId: 12, step: "anchor", error: 'The contract rejected the call: InvalidStatus(batchId=12, current=Recalled) ("no longer active").', readings: 12, consumed: true });
    assert.equal(
      line,
      '2026-11-10T09:23:00Z lot 12  FAILED    step=anchor error="The contract rejected the call: InvalidStatus(batchId=12, current=Recalled) (\\"no longer active\\")." readings=12 readingsKept=false',
    );
  });

  test("negative temperatures and a recovered transaction are shown clearly", () => {
    const base = { at, lotId: 3, logIndex: 4, readings: 9, minTenthsC: -268, maxTenthsC: -201, cid: "bafkreico3mky7o2d4zhu3i2epvch6c3f3aptcbslzg2z5v3ekm7uhxhbpi", blockNumber: null, txHash: null };
    assert.equal(
      formatEvent({ ...base, event: "anchor", outOfRange: 0, longestRun: 0, runLength: 3 }),
      "2026-11-10T09:23:00Z lot 3   ANCHOR    log=4 readings=9 min=-26.8C max=-20.1C cid=bafkreico3mky7o2d4zhu3i2epvch6c3f3aptcbslzg2z5v3ekm7uhxhbpi tx=confirmed-by-reading-the-lot",
    );
    const excursion = formatEvent({ ...base, event: "excursion", txHash: `0x${"ab".repeat(32)}`, blockNumber: 77, excursion: { t: at - 60, tenthsC: -268, rule: "3 consecutive readings outside -25.0 C to -15.0 C" } });
    assert.ok(excursion.includes('reading=-26.8C observedAt=2026-11-10T09:22:00Z rule="3 consecutive readings outside -25.0 C to -15.0 C"'));
    assert.ok(excursion.endsWith(`tx=0x${"ab".repeat(32)} block=77 status=Compromised`));
  });

  test("waits and retries explain themselves", () => {
    assert.equal(
      formatEvent({ at, event: "wait", lotId: 1, readings: 12, chainTime: at - 600, newestReading: at }),
      `2026-11-10T09:23:00Z lot 1   WAIT      readings=12 chainTime=2026-11-10T09:13:00Z newestReading=2026-11-10T09:23:00Z note="the chain's latest block is older than the newest reading; the log is closed once the chain's clock has caught up"`,
    );
    assert.equal(
      formatEvent({ at, event: "retry", lotId: null, step: "discover", attempt: 2, attempts: 4, delayMs: 1000, error: "Reading the number of lots failed: timeout." }),
      '2026-11-10T09:23:00Z oracle  RETRY     step=discover attempt=2/4 delayMs=1000 error="Reading the number of lots failed: timeout."',
    );
  });

  test("retries, waits and failures are diagnostics; results are not", () => {
    assert.deepEqual(["retry", "wait", "failure"].map((event) => isDiagnostic({ event })), [true, true, true]);
    assert.deepEqual(["ready", "start", "watch", "skip", "unwatch", "anchor", "excursion", "stop"].map((event) => isDiagnostic({ event })), new Array(8).fill(false));
  });

  test("an event type the formatter does not know is still printed", () => {
    assert.equal(formatEvent({ at, event: "calibrated", lotId: 2, offset: 3, note: "two words" }), '2026-11-10T09:23:00Z lot 2   CALIBRATED offset=3 note="two words"');
  });

  test("the JSON form keeps every field and adds an ISO time", () => {
    assert.deepEqual(JSON.parse(formatEventJson({ at, event: "skip", lotId: 2, status: "Recalled", reason: "the lot is Recalled" })), {
      time: "2026-11-10T09:23:00Z",
      at,
      event: "skip",
      lotId: 2,
      status: "Recalled",
      reason: "the lot is Recalled",
    });
  });
});

describe("the executable", () => {
  /** Run src/oracle/main.js as a child process with a minimal environment. */
  const execute = (args, env = {}) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env }, timeout: 20000 });

  test("npm run oracle -- --help prints the monitor help and exits 0", () => {
    const run = execute(["monitor", "--help"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `${MONITOR_USAGE}\n`);
    assert.equal(run.stderr, "");
  });

  test("npm run oracle:once -- --help and the general --help", () => {
    assert.equal(execute(["once", "--help"]).stdout, `${ONCE_USAGE}\n`);
    assert.equal(execute(["check", "--help"]).stdout, `${CHECK_USAGE}\n`);
    const general = execute(["--help"]);
    assert.equal(general.status, 0);
    assert.equal(general.stdout, `${ORACLE_USAGE}\n`);
  });

  test("wrong usage exits with 2 and an invalid configuration with 1, both without a stack trace", () => {
    const usage = execute(["once"]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /^error: --lot <id> is required/);

    const config = execute(["check"], { NETWORK: "mainnet" });
    assert.equal(config.status, 1);
    assert.match(config.stderr, /^error: Invalid configuration:\n {2}- NETWORK must be one of: localhost, amoy/);
    for (const run of [usage, config]) {
      assert.equal(run.stdout, "");
      assert.doesNotMatch(run.stderr, /\n\s+at .*\(.*\.js:\d+/);
    }
  });

  test("the package scripts point at the executables", async () => {
    const manifest = JSON.parse(await readFile(path.join(loadConfig({}).paths.packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.scripts.oracle, "node src/oracle/main.js monitor");
    assert.equal(manifest.scripts["oracle:once"], "node src/oracle/main.js once");
    assert.equal(manifest.scripts["oracle:check"], "node src/oracle/main.js check");
    assert.equal(manifest.scripts.simulate, "node src/simulator/main.js");
  });
});
