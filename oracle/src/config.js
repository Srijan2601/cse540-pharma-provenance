/**
 * Configuration: the ONLY module that reads environment variables.
 *
 * Every other module receives the validated, frozen object returned by
 * loadConfig(), so there is one place to look up a default, one place that
 * rejects a bad value, and no hidden global state.
 *
 * Design choices:
 *   - Zero configuration works. With no variables set, the package targets
 *     the local Hardhat node and stores files in a local directory, which is
 *     the proposal's contingency demo ("if Amoy or IPFS is down").
 *   - All problems are reported together, each with the variable name and
 *     what a valid value looks like, so a mistake is fixed in one round.
 *   - Secrets are wrapped in Secret. Printing the config, JSON.stringify,
 *     util.inspect and string interpolation all show a placeholder; the only
 *     way to obtain the value is an explicit .reveal() at the point of use.
 *     Error messages never quote a secret, only its length.
 *   - This module does not touch the file system. An optional .env file is
 *     loaded by loadEnvFile(), which only the command-line entry points call.
 */

import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress, isAddress } from "ethers";

import { ConfigError } from "./errors.js";
import { MAX_RAW_BLOCK_BYTES } from "./ipfs/cid.js";
import { normalizeGatewayUrl } from "./ipfs/gateway.js";

/** Hard ceiling for UPLOAD_MAX_BYTES: an upload is buffered in memory to be hashed. */
export const UPLOAD_HARD_MAX_BYTES = 33554432;
/** Largest SIM_LOG_SIZE; equals the "readings" maxItems of the sensor-log schema. */
export const MAX_LOG_READINGS = 2000;

/** Networks the oracle can target: expected chain id and a keyless default RPC endpoint. */
export const NETWORKS = Object.freeze({
  localhost: Object.freeze({ chainId: 31337, rpcUrl: "http://127.0.0.1:8545" }),
  amoy: Object.freeze({ chainId: 80002, rpcUrl: "https://polygon-amoy-bor-rpc.publicnode.com" }),
});

/** Storage backends (design decision O3). */
export const IPFS_BACKENDS = Object.freeze(["local", "kubo", "pinata"]);

/** Dev-server and preview origins of the Vite dApp, allowed to POST /upload by default. */
export const DEFAULT_CORS_ORIGINS = Object.freeze([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);

/**
 * Read-only gateway used after the local directory when a remote backend is
 * selected. Kubo: the daemon's own gateway. Pinata: a public gateway, since
 * content pinned on the public network is reachable from any of them.
 */
const DEFAULT_GATEWAYS = Object.freeze({
  local: null,
  kubo: "http://127.0.0.1:8080/ipfs/",
  pinata: "https://ipfs.io/ipfs/",
});

const HIDDEN = "[hidden]";
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Absolute path of the oracle/ package directory (this file is oracle/src/config.js). */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A secret value that cannot be printed by accident.
 *
 * The value lives in a private field, so it is invisible to JSON.stringify,
 * util.inspect, console.log, Object.keys and spread. Use reveal() only where
 * the value is handed to the API that needs it.
 */
export class Secret {
  #value;

  /** @param {string} value */
  constructor(value) {
    this.#value = value;
    Object.freeze(this);
  }

  /**
   * Return the secret value.
   * @returns {string}
   */
  reveal() {
    return this.#value;
  }

  /** @returns {string} a placeholder, never the value */
  toString() {
    return HIDDEN;
  }

  /** @returns {string} a placeholder, never the value */
  toJSON() {
    return HIDDEN;
  }

  /** @returns {string} a placeholder, never the value */
  [INSPECT]() {
    return HIDDEN;
  }
}

/**
 * @typedef {object} OracleConfig
 * @property {"localhost"|"amoy"} network           NETWORK
 * @property {number} expectedChainId               chain id that `network` must report (31337 or 80002)
 * @property {string} rpcUrl                        RPC_URL; may embed an API key, so print it only through describeConfig()
 * @property {string|null} registryAddress          REGISTRY_ADDRESS override (checksummed), or null to use the deployment record
 * @property {Secret|null} oraclePrivateKey         ORACLE_PRIVATE_KEY ("0x" + 64 hex once revealed), or null
 * @property {object} ipfs
 * @property {"local"|"kubo"|"pinata"} ipfs.backend IPFS_BACKEND
 * @property {string} ipfs.localDir                 IPFS_LOCAL_DIR, absolute
 * @property {string} ipfs.kuboApiUrl               KUBO_API_URL, no trailing slash
 * @property {Secret|null} ipfs.pinataJwt           PINATA_JWT
 * @property {string|null} ipfs.gatewayUrl          IPFS_GATEWAY_URL, ends with "/" (a CID is appended), or null for none
 * @property {object} service
 * @property {string} service.host                  IPFS_SERVICE_HOST
 * @property {number} service.port                  IPFS_SERVICE_PORT (0 = let the OS pick, used by tests)
 * @property {readonly string[]} service.corsOrigins IPFS_SERVICE_CORS_ORIGINS
 * @property {number} service.maxUploadBytes        UPLOAD_MAX_BYTES
 * @property {Secret|null} service.uploadToken      UPLOAD_TOKEN
 * @property {object} simulator
 * @property {number} simulator.seed                SIM_SEED
 * @property {number} simulator.sampleSeconds       SIM_SAMPLE_SECONDS
 * @property {number} simulator.logSize             SIM_LOG_SIZE
 * @property {object} excursion
 * @property {number} excursion.runLength           EXCURSION_RUN_LENGTH (the K of "K consecutive out-of-range readings")
 * @property {object} paths
 * @property {string} paths.packageRoot             absolute path of oracle/
 * @property {string} paths.repoRoot                absolute path of the repository
 * @property {string} paths.deploymentFile          deployments/<network>.json
 * @property {string} paths.abiFile                 deployments/abi/ProvenanceRegistry.json
 * @property {string} paths.schemasDir              docs/schemas
 * @property {string} paths.invocationDir           directory the user ran the command from; relative file arguments resolve against it
 */

/**
 * Read and validate the configuration.
 *
 * @param {Record<string, string|undefined>} [env] the variables to read; defaults to process.env.
 *        Tests pass a plain object. An empty string counts as "not set", as in a .env file line `NAME=`.
 * @returns {OracleConfig} a deeply frozen configuration object
 * @throws {ConfigError} listing every invalid variable
 */
export function loadConfig(env = process.env) {
  const problems = [];
  const read = (name) => {
    const value = env[name];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };

  // --- chain -------------------------------------------------------------
  let network = read("NETWORK") ?? "localhost";
  if (!Object.hasOwn(NETWORKS, network)) {
    problems.push(`NETWORK must be one of: ${Object.keys(NETWORKS).join(", ")} (got "${network}").`);
    network = "localhost";
  }

  const rpcUrl = parseUrl(read("RPC_URL"), "RPC_URL", NETWORKS[network].rpcUrl, problems);

  let registryAddress = null;
  const rawRegistry = read("REGISTRY_ADDRESS");
  if (rawRegistry !== undefined) {
    if (isAddress(rawRegistry)) {
      registryAddress = getAddress(rawRegistry);
    } else {
      // Not echoed: a private key pasted into the wrong variable must not end up in a terminal or log.
      problems.push(
        `REGISTRY_ADDRESS is not a valid address (${rawRegistry.length} characters; expected "0x" + 40 hex digits, with a correct checksum if mixed case).`,
      );
    }
  }

  let oraclePrivateKey = null;
  const rawKey = read("ORACLE_PRIVATE_KEY");
  if (rawKey !== undefined) {
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey)) {
      oraclePrivateKey = new Secret(rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`);
    } else {
      problems.push(
        `ORACLE_PRIVATE_KEY must be 64 hex digits, optionally prefixed with "0x" (got ${rawKey.length} characters; the value is not shown).`,
      );
    }
  }

  // --- IPFS storage ------------------------------------------------------
  let backend = read("IPFS_BACKEND") ?? "local";
  if (!IPFS_BACKENDS.includes(backend)) {
    problems.push(`IPFS_BACKEND must be one of: ${IPFS_BACKENDS.join(", ")} (got "${backend}").`);
    backend = "local";
  }

  // A relative directory is resolved against oracle/, not the current directory, so the service,
  // the CLI and the oracle share one store no matter where they are started from.
  const localDir = path.resolve(PACKAGE_ROOT, read("IPFS_LOCAL_DIR") ?? ".ipfs-store");

  const kuboApiUrl = parseKuboUrl(read("KUBO_API_URL"), problems);

  let pinataJwt = null;
  const rawJwt = read("PINATA_JWT");
  if (rawJwt !== undefined) {
    if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(rawJwt)) {
      pinataJwt = new Secret(rawJwt);
    } else {
      problems.push(
        "PINATA_JWT does not look like a JWT (three base64url parts separated by dots). Use the JWT shown when the Pinata API key was created, not the key or its secret.",
      );
    }
  }
  if (backend === "pinata" && rawJwt === undefined) {
    problems.push("PINATA_JWT is required when IPFS_BACKEND=pinata.");
  }

  const gatewayUrl = parseGatewayUrl(read("IPFS_GATEWAY_URL"), DEFAULT_GATEWAYS[backend], problems);

  // --- upload + gateway service -------------------------------------------
  const host = read("IPFS_SERVICE_HOST") ?? "127.0.0.1";
  if (isIP(host) === 0 && !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    problems.push(`IPFS_SERVICE_HOST must be a host name or IP address without scheme or port (got "${host}").`);
  }

  const port = parseInteger(read("IPFS_SERVICE_PORT"), "IPFS_SERVICE_PORT", 8787, 0, 65535, problems);

  const corsOrigins = parseOrigins(read("IPFS_SERVICE_CORS_ORIGINS"), problems);

  // The local backend stores one IPFS block per file, so a larger limit could never be honoured there.
  const uploadCeiling = backend === "local" ? MAX_RAW_BLOCK_BYTES : UPLOAD_HARD_MAX_BYTES;
  const maxUploadBytes = parseInteger(
    read("UPLOAD_MAX_BYTES"),
    "UPLOAD_MAX_BYTES",
    MAX_RAW_BLOCK_BYTES,
    1,
    uploadCeiling,
    problems,
    backend === "local" ? " with IPFS_BACKEND=local, which stores each file as one IPFS block" : "",
  );

  let uploadToken = null;
  const rawToken = read("UPLOAD_TOKEN");
  if (rawToken !== undefined) {
    // RFC 6750 "b64token" characters: the token travels in an Authorization header.
    if (/^[A-Za-z0-9\-._~+/]{16,}=*$/.test(rawToken)) {
      uploadToken = new Secret(rawToken);
    } else {
      problems.push(
        `UPLOAD_TOKEN must be at least 16 characters from A-Z a-z 0-9 - . _ ~ + / (got ${rawToken.length} characters; the value is not shown). Example: openssl rand -hex 24`,
      );
    }
  }

  // --- simulator and excursion rule (read by src/simulator and src/oracle) --
  const seed = parseInteger(read("SIM_SEED"), "SIM_SEED", 540, 0, 4294967295, problems);
  const sampleSeconds = parseInteger(read("SIM_SAMPLE_SECONDS"), "SIM_SAMPLE_SECONDS", 60, 1, 86400, problems);
  const logSize = parseInteger(read("SIM_LOG_SIZE"), "SIM_LOG_SIZE", 12, 1, MAX_LOG_READINGS, problems);
  // EXCURSION_RUN_LENGTH is deliberately not capped at SIM_LOG_SIZE. The oracle counts a run of
  // out-of-range readings across consecutive logs of a lot (src/oracle/rule.js), so a K that is
  // larger than one log is valid: the report is simply sent in the log in which the run completes.
  const runLength = parseInteger(read("EXCURSION_RUN_LENGTH"), "EXCURSION_RUN_LENGTH", 3, 1, MAX_LOG_READINGS, problems);

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  const repoRoot = path.resolve(PACKAGE_ROOT, "..");
  // "npm run" changes the working directory to oracle/ and records where the user actually was in
  // INIT_CWD. Using it lets "npm --prefix oracle run ipfs:add -- docs/x.json" work from the repository root.
  const initCwd = read("INIT_CWD");
  const invocationDir = initCwd !== undefined && path.isAbsolute(initCwd) ? initCwd : process.cwd();
  const config = {
    network,
    expectedChainId: NETWORKS[network].chainId,
    rpcUrl,
    registryAddress,
    oraclePrivateKey,
    ipfs: { backend, localDir, kuboApiUrl, pinataJwt, gatewayUrl },
    service: { host, port, corsOrigins, maxUploadBytes, uploadToken },
    simulator: { seed, sampleSeconds, logSize },
    excursion: { runLength },
    paths: {
      packageRoot: PACKAGE_ROOT,
      repoRoot,
      deploymentFile: path.join(repoRoot, "deployments", `${network}.json`),
      abiFile: path.join(repoRoot, "deployments", "abi", "ProvenanceRegistry.json"),
      schemasDir: path.join(repoRoot, "docs", "schemas"),
      invocationDir,
    },
  };

  // RPC_URL may carry an API key in its path, so even an accidental console.log(config) or
  // JSON.stringify(config) goes through the redacted summary. The hooks are non-enumerable so
  // they do not show up as configuration values.
  Object.defineProperty(config, "toJSON", { value: () => describeConfig(config) });
  Object.defineProperty(config, INSPECT, { value: () => describeConfig(config) });
  return deepFreeze(config);
}

/**
 * A printable summary of a configuration with every secret removed.
 *
 * Secrets appear as "set (hidden)" or "not set". URLs lose the parts that may
 * hold credentials: user info everywhere, and the path and query of RPC_URL
 * (RPC providers put the API key there).
 *
 * @param {OracleConfig} config
 * @returns {object} plain JSON-serializable data, safe to log
 */
export function describeConfig(config) {
  const secret = (value) => (value ? "set (hidden)" : "not set");
  return {
    network: config.network,
    expectedChainId: config.expectedChainId,
    rpcUrl: redactUrl(config.rpcUrl, { hidePath: true }),
    registryAddress: config.registryAddress ?? `from deployments/${config.network}.json`,
    oraclePrivateKey: secret(config.oraclePrivateKey),
    ipfs: {
      backend: config.ipfs.backend,
      localDir: config.ipfs.localDir,
      kuboApiUrl: redactUrl(config.ipfs.kuboApiUrl),
      pinataJwt: secret(config.ipfs.pinataJwt),
      gatewayUrl: config.ipfs.gatewayUrl ?? "none (local store only)",
    },
    service: {
      host: config.service.host,
      port: config.service.port,
      corsOrigins: [...config.service.corsOrigins],
      maxUploadBytes: config.service.maxUploadBytes,
      uploadToken: secret(config.service.uploadToken),
    },
    simulator: { ...config.simulator },
    excursion: { ...config.excursion },
  };
}

/**
 * Load variables from an env file into process.env if the file exists.
 *
 * Only the command-line entry points call this. Variables already present in
 * the environment win over the file (Node's process.loadEnvFile semantics),
 * and a missing file is not an error: the package must run with no file at all.
 *
 * @param {string} [file] defaults to oracle/.env
 * @returns {boolean} true if a file was loaded
 */
export function loadEnvFile(file = path.join(PACKAGE_ROOT, ".env")) {
  try {
    process.loadEnvFile(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new ConfigError([`Could not read the env file at ${file}: ${error.message}`]);
  }
}

/**
 * Tell whether a bind address is reachable only from this machine.
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Validate an http(s) URL setting.
 * @param {string|undefined} raw the value, or undefined to use the fallback
 * @param {string} name variable name for messages
 * @param {string} fallback default value (always valid)
 * @param {string[]} problems collects error messages
 * @returns {string} the validated URL (or the fallback when invalid, so validation can continue)
 */
function parseUrl(raw, name, fallback, problems) {
  if (raw === undefined) return fallback;
  let url;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    // The value is not echoed because RPC URLs often contain an API key.
    problems.push(`${name} must be an http:// or https:// URL (the value is not shown; it has ${raw.length} characters).`);
    return fallback;
  }
  return raw;
}

/**
 * Validate KUBO_API_URL: the base URL of a Kubo RPC API, to which "/api/v0/..." is appended.
 * @param {string|undefined} raw
 * @param {string[]} problems
 * @returns {string} the base URL without a trailing slash
 */
function parseKuboUrl(raw, problems) {
  const fallback = "http://127.0.0.1:5001";
  if (raw === undefined) return fallback;
  let url;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  // fetch() refuses URLs with embedded credentials, and a query string cannot be combined with the API path.
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.search || url.hash || url.username || url.password) {
    problems.push(
      'KUBO_API_URL must be the http(s) base URL of a Kubo RPC API such as "http://127.0.0.1:5001", without query string, fragment or credentials.',
    );
    return fallback;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Validate IPFS_GATEWAY_URL and normalize it to a prefix that a CID can be appended to
 * (the rules are those of normalizeGatewayUrl in ./ipfs/gateway.js).
 * @param {string|undefined} raw
 * @param {string|null} fallback the backend's default gateway
 * @param {string[]} problems
 * @returns {string|null}
 */
function parseGatewayUrl(raw, fallback, problems) {
  if (raw === undefined) return fallback;
  try {
    return normalizeGatewayUrl(raw);
  } catch {
    problems.push(
      'IPFS_GATEWAY_URL must be an http(s) URL prefix such as "https://ipfs.io/ipfs/", without query string, fragment or credentials.',
    );
    return fallback;
  }
}

/**
 * Validate a decimal integer setting.
 * @param {string|undefined} raw
 * @param {string} name
 * @param {number} fallback
 * @param {number} min inclusive
 * @param {number} max inclusive
 * @param {string[]} problems
 * @param {string} [context] appended to the range message to explain the bound
 * @returns {number}
 */
function parseInteger(raw, name, fallback, min, max, problems, context = "") {
  if (raw === undefined) return fallback;
  // Digits only: Number() would also accept "1e3", "0x10", " 5 " and "", which are almost always mistakes.
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}${context} (got "${raw}").`);
    return fallback;
  }
  return value;
}

/**
 * Validate the comma-separated origin allow-list for POST /upload.
 * @param {string|undefined} raw
 * @param {string[]} problems
 * @returns {string[]}
 */
function parseOrigins(raw, problems) {
  if (raw === undefined) return [...DEFAULT_CORS_ORIGINS];
  const origins = [];
  for (const entry of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    let origin = null;
    try {
      const url = new URL(entry);
      if (url.protocol === "http:" || url.protocol === "https:") origin = url.origin;
    } catch {
      origin = null;
    }
    // Compared with the entry itself so that a path, a trailing slash or "*" is rejected: the
    // browser sends a bare origin, and a wildcard would let any web page upload through a visitor's browser.
    if (origin === null || origin !== entry) {
      problems.push(
        `IPFS_SERVICE_CORS_ORIGINS entry "${entry}" is not an origin. Use scheme://host[:port] with no path or trailing slash, for example http://localhost:5173 (wildcards are not accepted).`,
      );
    } else if (!origins.includes(origin)) {
      origins.push(origin);
    }
  }
  return origins;
}

/**
 * Remove the parts of a URL that may hold credentials.
 * @param {string} value a valid URL
 * @param {{ hidePath?: boolean }} [options] hidePath also hides path and query (for RPC endpoints)
 * @returns {string}
 */
function redactUrl(value, { hidePath = false } = {}) {
  const url = new URL(value);
  const hasCredentials = url.username !== "" || url.password !== "";
  const prefix = `${url.protocol}//${hasCredentials ? `${HIDDEN}@` : ""}${url.host}`;
  const hasPath = url.pathname !== "/" || url.search !== "";
  if (hidePath) return hasPath ? `${prefix}/${HIDDEN}` : prefix;
  return `${prefix}${url.pathname === "/" ? "" : url.pathname}${url.search ? `?${HIDDEN}` : ""}`;
}

/**
 * Freeze an object graph. Secret instances freeze themselves; primitives are returned unchanged.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  }
  return value;
}
