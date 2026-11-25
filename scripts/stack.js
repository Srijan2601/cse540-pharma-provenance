// One-command local start of the whole demo on one laptop: local chain,
// deployed registry with the demo roles, file service and web app.
//
// Usage (repository root):
//   npm run setup            once after cloning: install the three packages, compile the contracts
//   npm start                start everything; Ctrl+C stops everything
//   npm start -- --seed      also create five demo lots with real documents
//   npm start -- --lan       also reachable from a phone on the same Wi-Fi (can be combined with --seed)
//
// What it does, in order:
//   1. checks the prerequisites (Node version, installed packages, free ports)
//      and stops with one instruction if something is missing;
//   2. starts `hardhat node` on port 8545 and waits until it answers;
//   3. runs scripts/deploy.js and scripts/grant-roles.js against it, the same
//      scripts as `npm run deploy:local` and `npm run roles:local`, so
//      deployments/localhost.json is exactly what the manual steps write;
//   4. starts the upload + gateway file service of oracle/ on port 8787;
//   5. with --seed, creates the demo lots (scripts/lib/seed-demo-lots.js);
//   6. starts the web app's dev server on port 5173;
//   7. prints where everything is and what to try next, then stays in the
//      foreground until Ctrl+C or until one of the three services exits.
//
// Design decisions:
//   - The ports are the defaults of every part of the project. The web app
//     and the oracle find the chain and the file service on them with no
//     configuration, which is why the ports are not options here.
//   - One process per service. Hardhat, the file service and Vite are started
//     through their entry scripts with the Node executable that runs this
//     file. No npm or shell process sits in between, so a signal reaches the
//     process that holds the port, on every operating system.
//   - Each child leads its own process group (not on Windows, which has
//     none). Ctrl+C in the terminal then reaches only this launcher, which
//     stops the children itself and checks that the three ports are free
//     before it exits. Signalling the group also stops any helper process a
//     tool may have started.
//   - The terminal stays readable. A child's output is prefixed with its name
//     and shown only when it is not routine: the chain's trace of every
//     JSON-RPC request, the file service's line per served request and the
//     dev server's notices are dropped. If a child fails before it answers,
//     its last lines are printed, whatever they were. A child that fails
//     later has already shown its errors as they arrived, so nothing is
//     repeated.
//   - No private key is used or shown. Transactions are signed by the node
//     through its unlocked test accounts, and the lines in which the node
//     prints the keys of those accounts never reach the terminal.
//   - Only Node built-ins are imported at the top of this file, so the
//     prerequisite check also works on a clone without node_modules. ethers
//     and the seed are imported after the check has passed.
//
// --lan binds the three services to all network interfaces instead of the
// loopback address, and makes the QR codes point at this computer's network
// address. Everyone on the network can then use the test accounts and the
// upload endpoint, so it is meant for a network you trust.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const fromRoot = (...segments) => path.join(ROOT, ...segments);

/** Oldest Node.js release the three packages support ("engines" in their package.json). */
const MIN_NODE = [22, 13];
/** Chain id of a local Hardhat node. */
const CHAIN_ID = 31337;

/** The three long-running services: the name prefixes their output, the title is used in sentences. */
const CHAIN = { name: "chain", title: "local chain", port: 8545 };
const FILES = { name: "files", title: "file service", port: 8787 };
const WEB = { name: "web", title: "web app", port: 5173 };
const SERVICES = [CHAIN, FILES, WEB];

/** How long a service may take to answer after it was started. */
const START_TIMEOUT_MS = 60000;
/** How long the children get to exit after SIGTERM before they are killed. */
const STOP_GRACE_MS = 5000;
/** Lines of a child's output that are kept to explain a failure. */
const TAIL_LINES = 20;

const WINDOWS = process.platform === "win32";
const ANSI_COLOURS = /\x1b\[[0-9;]*m/g;
/** The node's start-up banner lists the well-known private keys of its test accounts; they are never shown. */
const PRIVATE_KEY_LINE = /private key/i;
/** A request the file service answered with a 1xx, 2xx or 3xx status: "<time> GET /ipfs/<cid> 200". */
const SERVED_REQUEST = /^\S+ [A-Z]+ \S+ [1-3]\d\d$/;

/** Words for the contract's role constants, as the web app shows them. */
const ROLE_LABELS = {
  REGULATOR_ROLE: "Regulator",
  MANUFACTURER_ROLE: "Manufacturer",
  DISTRIBUTOR_ROLE: "Distributor",
  RETAILER_ROLE: "Pharmacy",
  ORACLE_ROLE: "IoT oracle",
};
/** Statuses in which the contract still accepts sensor data for a lot. */
const ACTIVE_STATUSES = ["Created", "InTransit", "Stored"];

/** Children that have not exited yet. Filled by spawnChild(), read by shutdown(). */
const children = new Set();
/** True once shutdown() has begun: it runs once, and child exits are then expected. */
let stopping = false;

/**
 * Print one line with the name of its source in front, for example "[chain]  ...".
 * @param {string} name
 * @param {string} line
 */
function print(name, line) {
  process.stdout.write(`${`[${name}]`.padEnd(9)}${line}\n`);
}

/** Print a line of the launcher itself. */
const say = (line) => print("stack", line);

/** "a", "a and b", "a, b, and c". */
const sentenceList = (items) => new Intl.ListFormat("en", { type: "conjunction" }).format(items);

/**
 * Read the command line. There are two flags and nothing else to configure.
 * @returns {{ seed: boolean, lan: boolean }}
 */
function readOptions() {
  try {
    const { values } = parseArgs({ options: { seed: { type: "boolean", default: false }, lan: { type: "boolean", default: false } } });
    return values;
  } catch (error) {
    say(error.message);
    // npm passes on what follows its one "--"; a second "--" would turn --lan into a positional argument.
    say("Usage: npm start [-- --seed] [--lan]     for example: npm start -- --seed --lan");
    process.exit(2);
  }
}

/**
 * Explain why the demo cannot start and exit. Used before any child exists.
 * @param {string[]} lines the problem, then the one thing to do about it
 * @returns {never}
 */
function refuse(lines) {
  say(`Cannot start: ${lines[0]}`);
  for (const line of lines.slice(1)) say(line);
  process.exit(1);
}

/**
 * Tell whether something on this machine accepts connections on a port.
 * Both loopback addresses are tried: a server bound to "localhost" may listen
 * on the IPv6 one only, and a browser opening http://localhost:<port> would
 * reach that server instead of ours.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function isPortInUse(port) {
  const accepts = (host) =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  return (await Promise.all(["127.0.0.1", "::1"].map(accepts))).includes(true);
}

/** The command that shows which process listens on a port. */
const findProcessCommand = (port) => (WINDOWS ? `netstat -ano | findstr :${port}` : `lsof -nP -iTCP:${port} -sTCP:LISTEN`);

/**
 * This computer's address on the local network, for --lan.
 * @returns {string|null} the first IPv4 address that is not a loopback address, or null without a network
 */
function findLanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

/**
 * Stop with one instruction if the demo cannot start: Node too old, a package
 * not installed, or a port taken (most often by a demo that is still running).
 */
async function checkPrerequisites() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    refuse([
      `Node.js ${MIN_NODE.join(".")} or newer is needed, and this is ${process.version}.`,
      "Install the current Node.js 22 from https://nodejs.org, then run the command again.",
    ]);
  }

  // One package that each part cannot run without stands for the whole install of that part.
  const installs = [
    ["node_modules", "hardhat"],
    ["oracle/node_modules", "ethers"],
    ["frontend/node_modules", "vite"],
  ];
  const missing = installs
    .filter(([folder, dependency]) => !existsSync(fromRoot(folder, dependency, "package.json")))
    .map(([folder]) => folder);
  if (missing.length > 0) {
    refuse([
      `the dependencies are not installed (${sentenceList(missing)} ${missing.length === 1 ? "is" : "are"} missing).`,
      "Run this once, then start again:   npm run setup",
    ]);
  }

  const taken = [];
  for (const service of SERVICES) {
    if (await isPortInUse(service.port)) taken.push(service);
  }
  if (taken.length > 0) {
    const ports = taken.map((service) => `port ${service.port} (${service.title})`);
    refuse([
      `${sentenceList(ports)} ${ports.length === 1 ? "is" : "are"} already in use.`,
      "If the demo is already running in another terminal, stop it there with Ctrl+C.",
      "To see which process holds a port:",
      ...taken.map((service) => `    ${findProcessCommand(service.port)}`),
    ]);
  }
}

/**
 * Path of a command-line tool's entry script, read from the "bin" entry of
 * its package, so the tool can be run with this Node executable directly.
 * @param {string} packageFolder the installed package, relative to the repository root
 * @param {string} tool name of the command
 * @returns {string} absolute path of the script
 */
function entryScript(packageFolder, tool) {
  const { bin } = JSON.parse(readFileSync(fromRoot(packageFolder, "package.json"), "utf8"));
  return fromRoot(packageFolder, typeof bin === "string" ? bin : bin[tool]);
}

/**
 * @typedef {object} Child
 * @property {string} name prefix of its output lines
 * @property {import("node:child_process").ChildProcess} process
 * @property {string[]} tail its last output lines, shown if it fails before it answers
 * @property {boolean} live true once the service answers; only then is its output shown as it arrives
 * @property {Promise<{ code: number|null, signal: string|null, error?: Error }>} closed resolves when it has exited
 */

/**
 * Start a Node script as a child process and collect its output.
 *
 * A line is printed as it arrives only when the child is live, no shutdown is
 * in progress and the line is not routine. Start-up banners and shutdown
 * notes therefore stay off the terminal, while every line is kept in `tail`
 * for the case that the child fails.
 *
 * @param {string} name prefix of its output lines
 * @param {string} script absolute path of the script
 * @param {string[]} args its arguments
 * @param {object} [options]
 * @param {string} [options.cwd] working directory (default: the repository root)
 * @param {Record<string, string>} [options.env] variables added to this process's environment
 * @param {(line: string, stream: "stdout"|"stderr") => boolean} [options.routine] lines not worth showing
 * @returns {Child}
 */
function spawnChild(name, script, args, { cwd = ROOT, env = {}, routine = () => false } = {}) {
  const proc = spawn(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    // The child leads a new process group (see the header). Windows has no process groups, and
    // "detached" would open a console window there.
    detached: !WINDOWS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child = { name, process: proc, tail: [], live: false, closed: null };

  for (const stream of ["stdout", "stderr"]) {
    createInterface({ input: proc[stream] }).on("line", (coloured) => {
      const line = coloured.replace(ANSI_COLOURS, "");
      if (PRIVATE_KEY_LINE.test(line)) return;
      child.tail.push(line);
      if (child.tail.length > TAIL_LINES) child.tail.shift();
      if (child.live && !stopping && !routine(line, stream)) print(name, line);
    });
  }

  child.closed = new Promise((resolve) => {
    // "close" fires after the output was read to its end, so `tail` is complete when it is printed.
    proc.once("close", (code, signal) => resolve({ code, signal }));
    // "error" means the process could not be started at all; "close" does not follow in that case.
    proc.once("error", (error) => resolve({ code: null, signal: null, error }));
  });
  children.add(child);
  child.closed.then(() => children.delete(child));
  return child;
}

/** Words for how a child ended. */
const describeExit = ({ code, signal, error }) => error?.message ?? (signal ? `signal ${signal}` : `exit status ${code}`);

/**
 * Show a child's last output lines. Skipped during a shutdown, when a child
 * that ends is no longer news, and for a live child: its lines that matter
 * were printed as they arrived, and the rest is routine output (for the
 * chain, its trace of JSON-RPC requests) that explains nothing.
 * @param {Child} child
 * @returns {string} words that point at those lines, to end the sentence that reports the failure
 */
function printTail(child) {
  if (stopping || child.live || child.tail.length === 0) return "";
  for (const line of child.tail) print(child.name, line);
  return "; its last output is above";
}

/**
 * Run a script to its end, quietly. Its output is shown only if it fails.
 * @param {string} name prefix of its output lines
 * @param {string} script absolute path of the script
 * @param {string[]} args its arguments
 */
async function runStep(name, script, args) {
  const child = spawnChild(name, script, args);
  const exit = await child.closed;
  if (exit.code !== 0) {
    const pointer = printTail(child);
    throw new Error(`The "${name}" step failed (${describeExit(exit)})${pointer}.`);
  }
}

/**
 * Start one of the three services and wait until it answers.
 *
 * From then on the service must keep running: if it exits, the launcher says
 * so and takes the other services down with it, so a broken demo never looks
 * like a running one.
 *
 * @param {{ name: string, title: string, port: number }} service
 * @param {string} script absolute path of the script
 * @param {string[]} args its arguments
 * @param {Parameters<typeof spawnChild>[3]} options see spawnChild()
 * @param {() => Promise<boolean>} answers resolves to true once the service is usable; may reject while it is not
 */
async function startService(service, script, args, options, answers) {
  say(`Starting the ${service.title} on port ${service.port} ...`);
  const child = spawnChild(service.name, script, args, options);
  child.closed.then((exit) => {
    if (stopping) return;
    const pointer = printTail(child);
    shutdown(1, `The ${service.title} stopped unexpectedly (${describeExit(exit)})${pointer}.`);
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await answers().catch(() => false))) {
    // A shutdown has begun (Ctrl+C, or this child died): leave the start-up sequence.
    if (stopping) throw new Error("interrupted");
    if (Date.now() > deadline) {
      const pointer = printTail(child);
      throw new Error(`The ${service.title} did not answer on port ${service.port} within ${START_TIMEOUT_MS / 1000} seconds${pointer}.`);
    }
    await delay(200);
  }
  child.live = true;
}

/**
 * Send a signal to every child that is still running.
 * @param {NodeJS.Signals} signal
 */
function signalChildren(signal) {
  for (const child of children) {
    try {
      // A negative pid addresses the whole process group that `detached` created.
      if (WINDOWS) child.process.kill(signal);
      else process.kill(-child.process.pid, signal);
    } catch {
      // The process has already exited.
    }
  }
}

/**
 * Stop every child, confirm that the ports are free, and exit.
 * Called for Ctrl+C, for a failure during start-up, and when a service exits.
 * @param {number} exitCode
 * @param {string} reason a sentence for the terminal
 */
async function shutdown(exitCode, reason) {
  if (stopping) return;
  stopping = true;
  say(children.size > 0 ? `${reason} Stopping everything that was started ...` : reason);

  signalChildren("SIGTERM");
  await Promise.race([Promise.all([...children].map((child) => child.closed)), delay(STOP_GRACE_MS)]);
  // Whatever did not exit in time is killed; a port needs a moment to close after its process is gone.
  signalChildren("SIGKILL");
  let listening = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const inUse = await Promise.all(SERVICES.map((service) => isPortInUse(service.port)));
    listening = SERVICES.filter((_, index) => inUse[index]);
    if (listening.length === 0) break;
    await delay(100);
  }

  if (listening.length === 0) {
    say(`Stopped. Ports ${sentenceList(SERVICES.map((service) => String(service.port)))} are free.`);
  } else {
    for (const service of listening) {
      say(`Port ${service.port} (${service.title}) is still in use. Find the process with:   ${findProcessCommand(service.port)}`);
    }
    exitCode = 1;
  }
  process.exit(exitCode);
}

/**
 * Ask the chain which of the node's test accounts hold which role, so the
 * summary shows what is on-chain now, not what a script was meant to grant.
 *
 * @param {typeof import("ethers")} ethers
 * @param {import("ethers").JsonRpcProvider} provider
 * @param {import("ethers").Contract} registry
 * @returns {Promise<{ index: number, address: string, roles: string[] }[]>} every test account, in the node's order
 */
async function readAccounts(ethers, provider, registry) {
  // The role identifiers are read from the contract's own constants instead of being recomputed here.
  const roles = await Promise.all(
    Object.entries(ROLE_LABELS).map(async ([constant, label]) => ({ id: await registry[constant](), label })),
  );
  const addresses = await provider.send("eth_accounts", []);
  return Promise.all(
    addresses.map(async (address, index) => {
      const holds = await Promise.all(roles.map((role) => registry.hasRole(role.id, address)));
      const held = roles.filter((_, position) => holds[position]).map((role) => role.label);
      return { index, address: ethers.getAddress(address), roles: held };
    }),
  );
}

/**
 * Print where everything is and what to try next.
 *
 * @param {object} stack
 * @param {string} stack.registryAddress
 * @param {{ index: number, address: string, roles: string[] }[]} stack.accounts from readAccounts()
 * @param {Awaited<ReturnType<import("./lib/seed-demo-lots.js").seedDemoLots>>|null} stack.seeded null without --seed
 * @param {string|null} stack.lanUrl address of the web app on the local network, or null without --lan
 */
function printSummary({ registryAddress, accounts, seeded, lanUrl }) {
  const webUrl = `http://localhost:${WEB.port}`;
  // The short form of a verify link: the app fills in the chain and the registry it knows.
  const verifyLink = (base, lotId) => `${base}/#/verify?lot=${lotId}`;
  const lines = [""];
  const section = (title) => lines.push("", `  ${title}`);
  const row = (label, value) => lines.push(`    ${label.padEnd(16)}${value}`);

  lines.push("  The demo is running. Press Ctrl+C in this terminal to stop it.");

  // The first seeded lot is the one with a complete, verified record.
  const showcase = seeded?.lots[0].id;

  section("Open");
  row("Web app", webUrl);
  if (seeded) row(`Verify lot ${showcase}`, verifyLink(webUrl, showcase));
  row("File service", `http://127.0.0.1:${FILES.port}`);
  row("Chain (RPC)", `http://127.0.0.1:${CHAIN.port}   chain id ${CHAIN_ID}`);
  row("Registry", registryAddress);

  if (lanUrl) {
    section("On a phone on the same Wi-Fi (--lan)");
    row("Web app", lanUrl);
    if (seeded) row(`Verify lot ${showcase}`, verifyLink(lanUrl, showcase));
    lines.push("    The QR codes in the web app point at this address. --lan exposes the chain, the file service");
    lines.push("    and the web app to every device on this network, so use it only on a network you trust.");
  }

  section("Local test accounts (Organization dashboard > Local test account; no wallet needed)");
  const withRole = accounts.filter((account) => account.roles.length > 0);
  for (const account of withRole) row(`#${account.index}  ${account.roles.join(", ")}`, ` ${account.address}`);
  // The accounts without a role need not be consecutive (the seed's second distributor is #6, while
  // #5 has none), so runs of consecutive numbers are joined into ranges: "#5 and #7 to #19".
  const idle = accounts.filter((account) => account.roles.length === 0).map((account) => account.index);
  const runs = [];
  for (const index of idle) {
    if (runs.at(-1)?.[1] === index - 1) runs.at(-1)[1] = index;
    else runs.push([index, index]);
  }
  if (runs.length > 0) {
    const ranges = runs.map(([first, last]) => (first === last ? `#${first}` : `#${first} to #${last}`));
    lines.push(`    ${sentenceList(ranges)} ${idle.length === 1 ? "holds" : "hold"} no role.`);
  }

  if (seeded) {
    section("Seeded lots");
    for (const lot of seeded.lots) lines.push(`    ${lot.id}  ${lot.status.padEnd(13)}${lot.note}`);
    lines.push(`    Key for lot ${seeded.attachment.lotId}'s encrypted attachment (${seeded.attachment.name}):`);
    lines.push(`      ${seeded.attachment.key}`);
  }

  // The excursion needs a lot the contract still accepts sensor data for.
  const activeLot = seeded?.lots.findLast((lot) => ACTIVE_STATUSES.includes(lot.status));
  section("Try next, in a second terminal in this folder");
  if (!activeLot) {
    lines.push("    (No lot exists yet. Register one in the web app as the Manufacturer, or restart with: npm start -- --seed)");
  }
  lines.push(`    npm run oracle:once -- --lot ${activeLot?.id ?? 1} --scenario excursion`);
  lines.push(`        the oracle reports a temperature excursion: lot ${activeLot?.id ?? 1} becomes Compromised`);
  lines.push("    SIM_SAMPLE_SECONDS=5 npm run oracle");
  lines.push("        the oracle watches every active lot and anchors one sensor log per lot a minute, until Ctrl+C");
  lines.push("    Ctrl+C in this terminal");
  lines.push(`        stops the ${sentenceList(SERVICES.map((service) => service.title))}`);
  lines.push("");

  process.stdout.write(`${lines.join("\n")}\n`);
}

/** Start everything, print the summary, and stay alive until a signal arrives or a service exits. */
async function main() {
  const { seed, lan } = readOptions();
  await checkPrerequisites();
  const lanAddress = lan ? findLanAddress() : null;
  if (lan && lanAddress === null) {
    refuse([
      "--lan needs a network, and this computer has no network address right now.",
      "Join the Wi-Fi the phone is on, or start without --lan.",
    ]);
  }
  // 0.0.0.0 means every network interface; 127.0.0.1 is reachable from this computer only.
  const host = lan ? "0.0.0.0" : "127.0.0.1";
  const lanUrl = lan ? `http://${lanAddress}:${WEB.port}` : null;
  // This launcher always talks to the services over the loopback address, with or without --lan.
  const chainUrl = `http://127.0.0.1:${CHAIN.port}`;
  const filesUrl = `http://127.0.0.1:${FILES.port}`;
  const hardhat = entryScript("node_modules/hardhat", "hardhat");
  /** GET or POST a local URL; a server that hangs counts as not answering. */
  const request = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(2000) });

  await startService(
    CHAIN,
    hardhat,
    ["node", "--hostname", host, "--port", String(CHAIN.port)],
    // Everything the node writes to stdout is its banner or its trace of JSON-RPC requests.
    { routine: (_line, stream) => stream === "stdout" },
    async () => {
      const response = await request(chainUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      return Number((await response.json()).result) === CHAIN_ID;
    },
  );

  say("Deploying ProvenanceRegistry and granting the demo roles ...");
  await runStep("deploy", hardhat, ["run", "scripts/deploy.js", "--network", "localhost"]);
  await runStep("roles", hardhat, ["run", "scripts/grant-roles.js", "--network", "localhost"]);

  // The file service accepts uploads only from web origins it knows. Its defaults cover the web
  // app opened on this computer; with --lan, a page opened through the network address is one more.
  const uploadOrigins = [`http://localhost:${WEB.port}`, `http://127.0.0.1:${WEB.port}`, lanUrl];
  await startService(
    FILES,
    fromRoot("oracle/src/cli/main.js"),
    ["serve"],
    {
      cwd: fromRoot("oracle"),
      env: {
        IPFS_SERVICE_HOST: host,
        IPFS_SERVICE_PORT: String(FILES.port),
        ...(lan ? { IPFS_SERVICE_CORS_ORIGINS: uploadOrigins.join(",") } : {}),
      },
      routine: (line) => SERVED_REQUEST.test(line),
    },
    async () => (await (await request(`${filesUrl}/health`)).json()).ok === true,
  );

  const ethers = await import("ethers");
  const deployment = JSON.parse(readFileSync(fromRoot("deployments/localhost.json"), "utf8"));
  // cacheTimeout -1 switches off ethers' 250 ms response cache. On a chain that mines every
  // transaction at once, a cached block number makes wait() believe a mined transaction is still
  // unconfirmed and fall back to polling every four seconds, which would make the seed take minutes.
  const provider = new ethers.JsonRpcProvider(chainUrl, CHAIN_ID, { staticNetwork: true, cacheTimeout: -1 });
  const registry = new ethers.Contract(deployment.address, deployment.abi, provider);

  let seeded = null;
  if (seed) {
    say("Creating five demo lots with their documents ...");
    const { seedDemoLots } = await import("./lib/seed-demo-lots.js");
    seeded = await seedDemoLots({ provider, registry, fileServiceUrl: filesUrl });
  }

  await startService(
    WEB,
    entryScript("frontend/node_modules/vite", "vite"),
    // --strictPort: fail instead of silently moving to another port, where the file service would
    // refuse the app's uploads. --logLevel warn: Vite itself keeps quiet about routine events.
    ["--host", host, "--port", String(WEB.port), "--strictPort", "--logLevel", "warn"],
    { cwd: fromRoot("frontend"), env: lan ? { VITE_VERIFY_BASE_URL: `${lanUrl}/` } : {} },
    // The dev server adds its client script to the page it serves. Looking for that script, instead
    // of accepting any answer, keeps another program that took the port after the prerequisite
    // check from passing for the web app; Vite then fails on the taken port and the start stops.
    async () => {
      const response = await request(`http://127.0.0.1:${WEB.port}/`);
      return response.ok && (await response.text()).includes("/@vite/client");
    },
  );

  const accounts = await readAccounts(ethers, provider, registry);
  provider.destroy();
  printSummary({ registryAddress: deployment.address, accounts, seeded, lanUrl });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    // The terminal echoes "^C" at the cursor; start the closing lines on a line of their own. Only
    // once: under "npm start" one Ctrl+C arrives twice, from the terminal and forwarded by npm.
    if (signal === "SIGINT" && process.stdout.isTTY && !stopping) process.stdout.write("\n");
    shutdown(0, signal === "SIGINT" ? "Ctrl+C." : `Received ${signal}.`);
  });
}
// Last resort for an exit that did not go through shutdown() (an uncaught exception): no child may outlive this process.
process.on("exit", () => signalChildren("SIGKILL"));

main().catch(async (error) => {
  // When a service dies in the middle of the start-up, the request that was talking to it fails
  // first, with nothing better to say than "connection reset". The exit handler of that service
  // (see startService) knows the real story, so it gets a moment to begin the shutdown itself;
  // the call below then does nothing.
  await delay(500);
  shutdown(1, `Start-up failed: ${error?.shortMessage ?? error?.message ?? String(error)}`);
});
