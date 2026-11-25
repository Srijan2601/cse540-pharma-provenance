/**
 * The commands of the command-line tool, kept separate from the executable
 * (main.js) so tests can run them in-process with captured output.
 *
 *   serve      start the upload + gateway service
 *   add        store a file, optionally encrypting it first
 *   get        fetch a file by CID, optionally decrypting it
 *   verify     check the content of a CID against an on-chain content hash
 *   hash       print the CID and content hash of a file without storing it
 *   validate   check a JSON document against its schema
 *   config     print the effective configuration with secrets hidden
 *
 * Conventions:
 *   - Results go to stdout; progress notes and errors go to stderr, so
 *     `get <cid> > file` and `--json | jq` work.
 *   - Exit code 0 = success; 1 = the check failed or the operation could not
 *     be completed; 2 = the command line was wrong.
 *   - A generated encryption key is printed exactly once, on stdout, and is
 *     stored nowhere. A key supplied by the user is never echoed.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { describeConfig, isLoopbackHost, loadConfig } from "../config.js";
import { EnvelopeError, ENCRYPTION_DESCRIPTOR, decodeKey, decrypt, encodeKey, encrypt, generateKey } from "../crypto/envelope.js";
import { createDocuments } from "../documents/index.js";
import { DocumentValidationError, IntegrityError, OracleError, UsageError } from "../errors.js";
import {
  GatewayClient,
  IPFS_SINGLE_CHUNK_BYTES,
  MAX_RAW_BLOCK_BYTES,
  computeContentHash,
  computeRawCid,
  createStorage,
  verifyContent,
} from "../ipfs/index.js";
import { UploadServiceClient } from "../service/client.js";
import { createUploadService } from "../service/server.js";

export const USAGE = `Usage: node src/cli/main.js <command> [options]      (or: npm run ipfs -- <command> [options])

Commands
  serve                               Start the upload + gateway service (npm run service).
  add <file>                          Store a file; prints its CID and content hash.
      --name <label>                    name shown by a pinning service (default: the file name)
      --encrypt                         encrypt with AES-256-GCM first; a new key is printed once
      --key <base64url> | --key-file <path>   use this key instead of generating one
      --service <url>                   upload through a running service instead of writing the store directly
  get <cid>                           Fetch a file; writes it to stdout or --out.
      --out <path>                      write to this file
      --decrypt --key <k> | --key-file <path>  decrypt an encrypted file after fetching it
      --gateway <url>                   fetch from this gateway only (e.g. http://127.0.0.1:8787)
  verify <cid> <contentHash>          Fetch the content and check it against the on-chain hash and the CID.
      --file <path>                     check a local file instead of fetching
      --gateway <url>                   fetch from this gateway only
  hash <file>                         Print the CID and content hash a file would get, without storing it.
  validate <file>                     Check a JSON document against its schema in docs/schemas/.
      --type <type>                     require lot-metadata, regulator-certificate or sensor-log
  config                              Print the effective configuration (secrets hidden).

Every command accepts --json for machine-readable output. Configuration comes from
environment variables; see the README.`;

/**
 * @typedef {object} CliIo
 * @property {Record<string, string|undefined>} [env]   environment to configure from (default process.env)
 * @property {(line: string) => void} [out]             writes a line of result text (default stdout)
 * @property {(line: string) => void} [err]             writes a line of diagnostics (default stderr)
 * @property {(bytes: Uint8Array) => void} [outBytes]   writes raw bytes of a fetched file (default stdout)
 * @property {AbortSignal} [signal]                     aborting it shuts down `serve`
 */

/**
 * Run one command.
 * @param {string[]} argv the arguments after the program name, for example ["add", "file.json", "--json"]
 * @param {CliIo} [io] output sinks, environment and shutdown signal; defaults to the real process
 * @returns {Promise<number>} the exit code
 */
export async function runCli(argv, io = {}) {
  const context = {
    env: io.env ?? process.env,
    out: io.out ?? ((line) => process.stdout.write(`${line}\n`)),
    err: io.err ?? ((line) => process.stderr.write(`${line}\n`)),
    outBytes: io.outBytes ?? ((bytes) => process.stdout.write(bytes)),
    signal: io.signal,
  };
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      context.out(USAGE);
      return command === undefined ? 2 : 0;
    }
    const handler = COMMANDS[command];
    if (handler === undefined) {
      throw new UsageError(`Unknown command "${command}".`);
    }
    return await handler(rest, context);
  } catch (error) {
    if (error instanceof UsageError) {
      context.err(`error: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof OracleError || error instanceof EnvelopeError) {
      // Expected, explained failures: the message is the whole story, a stack trace would only bury it.
      context.err(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/**
 * Warnings about a service configuration that is valid but exposes more than
 * the operator may intend. Printed by `serve` at start-up.
 * @param {import("../config.js").OracleConfig} config
 * @returns {string[]} zero or more one-line warnings
 */
export function serviceWarnings(config) {
  const warnings = [];
  if (!isLoopbackHost(config.service.host) && !config.service.uploadToken) {
    warnings.push(
      `listening on ${config.service.host} without UPLOAD_TOKEN: every device that can reach this address can upload. Set UPLOAD_TOKEN.`,
    );
  }
  return warnings;
}

/** @type {Record<string, (args: string[], context: Required<Omit<CliIo, "signal">> & { signal?: AbortSignal }) => Promise<number>>} */
const COMMANDS = {
  /** serve: run the service until the signal aborts. */
  async serve(args, context) {
    parse(args, {}, 0);
    const config = loadConfig(context.env);
    const storage = createStorage(config);
    const service = createUploadService({
      storage,
      ...config.service,
      log: (line) => context.err(`${new Date().toISOString()} ${line}`),
    });
    const { url } = await service.listen();
    context.err(`Upload + gateway service listening on ${url}`);
    context.err(`  backend            ${config.ipfs.backend} (local directory ${config.ipfs.localDir})`);
    context.err(`  gateway fallback   ${config.ipfs.gatewayUrl ?? "none"}`);
    context.err(`  upload limit       ${config.service.maxUploadBytes} bytes`);
    context.err(`  upload origins     ${config.service.corsOrigins.join(", ") || "none"}`);
    context.err(`  upload token       ${config.service.uploadToken ? "required" : "not required"}`);
    for (const warning of serviceWarnings(config)) {
      context.err(`  WARNING: ${warning}`);
    }
    context.err("Press Ctrl+C to stop.");

    await new Promise((resolve) => {
      if (context.signal === undefined) return; // No signal: run until the process is killed.
      if (context.signal.aborted) resolve(undefined);
      else context.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    context.err("Shutting down: finishing requests in progress...");
    await service.close();
    context.err("Service stopped.");
    return 0;
  },

  /** add: store a file, optionally encrypted. */
  async add(args, context) {
    const { values, positionals } = parse(
      args,
      { name: { type: "string" }, encrypt: { type: "boolean" }, key: { type: "string" }, "key-file": { type: "string" }, service: { type: "string" } },
      1,
    );
    const config = loadConfig(context.env);
    const file = userPath(config, positionals[0]);
    let bytes = await readInput(file);

    const suppliedKey = await readKey(config, values);
    if (suppliedKey !== null && !values.encrypt) {
      throw new UsageError("--key and --key-file only make sense together with --encrypt.");
    }
    let generatedKey = null;
    if (values.encrypt) {
      const key = suppliedKey ?? generateKey();
      if (suppliedKey === null) generatedKey = encodeKey(key);
      bytes = await encrypt(bytes, key);
    }

    const storage = values.service
      ? new UploadServiceClient({ baseUrl: values.service, token: config.service.uploadToken?.reveal() ?? null })
      : createStorage(config);
    const name = values.name ?? `${path.basename(file)}${values.encrypt ? ".enc" : ""}`;
    const stored = await storage.add(bytes, { name });

    if (values.json) {
      context.out(
        JSON.stringify({
          ...stored,
          encryption: values.encrypt ? ENCRYPTION_DESCRIPTOR : null,
          ...(generatedKey === null ? {} : { key: generatedKey }),
        }),
      );
      return 0;
    }
    context.out(`cid          ${stored.cid}`);
    context.out(`contentHash  ${stored.contentHash}`);
    context.out(`size         ${stored.size} bytes`);
    context.out(`stored via   ${values.service ? `service ${values.service}` : `${storage.name} backend`}`);
    if (values.encrypt) {
      context.out("encryption   AES-256-GCM, envelope v1 (the CID and content hash cover the encrypted bytes)");
    }
    if (generatedKey !== null) {
      context.out(`key          ${generatedKey}`);
      context.out("             Shown once and stored nowhere. Hand it over out of band; never upload or commit it.");
    }
    return 0;
  },

  /** get: fetch a file by CID, optionally decrypting it. */
  async get(args, context) {
    const { values, positionals } = parse(
      args,
      { out: { type: "string" }, decrypt: { type: "boolean" }, key: { type: "string" }, "key-file": { type: "string" }, gateway: { type: "string" } },
      1,
    );
    const config = loadConfig(context.env);
    const key = await readKey(config, values);
    if (values.decrypt && key === null) {
      throw new UsageError("--decrypt needs --key <base64url> or --key-file <path>.");
    }
    if (!values.decrypt && key !== null) {
      throw new UsageError("--key and --key-file only make sense together with --decrypt.");
    }

    let bytes = await source(config, values.gateway).get(positionals[0]);
    if (values.decrypt) {
      bytes = await decrypt(bytes, key);
    }
    if (values.out) {
      const target = userPath(config, values.out);
      await writeFile(target, bytes);
      context.err(`wrote ${bytes.length} bytes to ${target}`);
    } else {
      context.outBytes(bytes);
    }
    return 0;
  },

  /** verify: check content against { cid, contentHash }. */
  async verify(args, context) {
    const { values, positionals } = parse(args, { file: { type: "string" }, gateway: { type: "string" } }, 2);
    const [cid, contentHash] = positionals;
    const config = loadConfig(context.env);

    let origin;
    let bytes;
    if (values.file) {
      const file = userPath(config, values.file);
      origin = `file ${file}`;
      bytes = await readInput(file);
    } else {
      const reader = source(config, values.gateway);
      origin = values.gateway ? `gateway ${reader.baseUrl}` : `${reader.name} backend`;
      try {
        bytes = await reader.get(cid);
      } catch (error) {
        if (!(error instanceof IntegrityError)) throw error;
        // The storage layer refuses to hand over bytes that contradict their CID. For a verifier that is a result, not a crash.
        if (values.json) context.out(JSON.stringify({ ok: false, source: origin, summary: `NOT verified: ${error.message}` }));
        else context.out(`source        ${origin}\nresult        NOT VERIFIED: ${error.message}`);
        return 1;
      }
    }

    const report = verifyContent(bytes, { cid, contentHash });
    const documentNote = describeDocument(config, bytes);
    if (values.json) {
      context.out(JSON.stringify({ ...report, source: origin, document: documentNote }));
      return report.ok ? 0 : 1;
    }
    const mark = (matches) => (matches ? "MATCH   " : "MISMATCH");
    context.out(`source        ${origin}`);
    context.out(`size          ${report.size} bytes`);
    context.out(`content hash  ${mark(report.contentHash.matches)} keccak256(bytes) = ${report.contentHash.actual}`);
    if (!report.contentHash.matches) {
      context.out(`              expected ${report.contentHash.expected || "(none given)"}${report.contentHash.valid ? "" : " (not a 32-byte hex value)"}`);
    }
    context.out(`CID digest    ${report.cid.checked ? mark(report.cid.matches) : "SKIPPED "} ${report.cid.detail}`);
    if (documentNote !== null) {
      context.out(`document      ${documentNote}`);
    }
    context.out(`result        ${report.ok ? "VERIFIED" : "NOT VERIFIED"}: ${report.summary.replace(/^(NOT )?verified: /, "")}`);
    return report.ok ? 0 : 1;
  },

  /** hash: CID and content hash of a file, without storing it. */
  async hash(args, context) {
    const { values, positionals } = parse(args, {}, 1);
    const config = loadConfig(context.env);
    const bytes = await readInput(userPath(config, positionals[0]));
    const result = { cid: computeRawCid(bytes), contentHash: computeContentHash(bytes), size: bytes.length };
    if (values.json) {
      context.out(JSON.stringify(result));
      return 0;
    }
    context.out(`cid          ${result.cid}`);
    context.out(`contentHash  ${result.contentHash}`);
    context.out(`size         ${result.size} bytes`);
    if (bytes.length > MAX_RAW_BLOCK_BYTES) {
      context.err(`note: larger than ${MAX_RAW_BLOCK_BYTES} bytes, so the local backend would refuse to store it.`);
    } else if (bytes.length > IPFS_SINGLE_CHUNK_BYTES) {
      context.err(
        `note: larger than ${IPFS_SINGLE_CHUNK_BYTES} bytes. A real IPFS node splits such a file into chunks and reports a different ("bafybei...") CID; the content hash is unaffected.`,
      );
    }
    return 0;
  },

  /** validate: check a JSON document against its schema and the cross-field rules. */
  async validate(args, context) {
    const { values, positionals } = parse(args, { type: { type: "string" } }, 1);
    const config = loadConfig(context.env);
    const file = userPath(config, positionals[0]);
    const bytes = await readInput(file);
    const documents = createDocuments({ schemasDir: config.paths.schemasDir });
    try {
      const { type, document } = documents.parse(bytes, values.type);
      const result = { valid: true, type, schemaVersion: document.schemaVersion, cid: computeRawCid(bytes), contentHash: computeContentHash(bytes), size: bytes.length };
      if (values.json) {
        context.out(JSON.stringify(result));
      } else {
        context.out(`valid ${type} document (schemaVersion ${result.schemaVersion})`);
        context.out(`cid          ${result.cid}`);
        context.out(`contentHash  ${result.contentHash}`);
        context.out(`size         ${result.size} bytes`);
      }
      return 0;
    } catch (error) {
      if (!(error instanceof DocumentValidationError)) throw error;
      if (values.json) {
        context.out(JSON.stringify({ valid: false, type: error.documentType, errors: error.errors }));
      } else {
        context.out(`INVALID ${error.documentType} document: ${file}`);
        for (const problem of error.errors) context.out(`  ${problem.path}: ${problem.message}`);
      }
      return 1;
    }
  },

  /** config: print the effective configuration without secrets. */
  async config(args, context) {
    parse(args, {}, 0);
    context.out(JSON.stringify(describeConfig(loadConfig(context.env)), null, 2));
    return 0;
  },
};

/**
 * Parse the options of one command. Unknown options and a wrong number of
 * positional arguments are usage errors.
 * @param {string[]} args
 * @param {import("node:util").ParseArgsConfig["options"]} options command-specific options; --json is always accepted
 * @param {number} positionalCount exact number of positional arguments
 * @returns {{ values: Record<string, any>, positionals: string[] }}
 */
function parse(args, options, positionalCount) {
  let parsed;
  try {
    parsed = parseArgs({ args: joinKeyValues(args), options: { ...options, json: { type: "boolean" } }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (parsed.positionals.length !== positionalCount) {
    throw new UsageError(`Expected ${positionalCount} argument(s) but got ${parsed.positionals.length}.`);
  }
  return parsed;
}

/**
 * Attach the value of --key to the option itself ("--key=<value>").
 *
 * A key is 43 random base64url characters, and "-" is one of the 64. Node's
 * argument parser refuses a separate value that starts with a dash ("did you
 * forget the argument?"), so without this step one generated key in 64 could
 * not be passed as "--key <value>". Whatever follows --key is its value.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function joinKeyValues(args) {
  const joined = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--key" && i + 1 < args.length) {
      joined.push(`--key=${args[i + 1]}`);
      i += 1;
    } else {
      joined.push(args[i]);
    }
  }
  return joined;
}

/**
 * Resolve a path typed by the user against the directory they ran the command from.
 * @param {import("../config.js").OracleConfig} config
 * @param {string} file
 * @returns {string}
 */
function userPath(config, file) {
  return path.resolve(config.paths.invocationDir, file);
}

/**
 * Read an input file, turning a missing or unreadable file into a usage error.
 * @param {string} file absolute path
 * @returns {Promise<Uint8Array>}
 */
async function readInput(file) {
  try {
    return new Uint8Array(await readFile(file));
  } catch (error) {
    throw new UsageError(`Cannot read ${file}: ${error.code ?? error.message}.`);
  }
}

/**
 * Read the encryption key from --key or --key-file.
 * @param {import("../config.js").OracleConfig} config
 * @param {Record<string, any>} values parsed options
 * @returns {Promise<Uint8Array|null>} the 32 key bytes, or null when neither option was given
 */
async function readKey(config, values) {
  if (values.key !== undefined && values["key-file"] !== undefined) {
    throw new UsageError("Give either --key or --key-file, not both.");
  }
  if (values.key !== undefined) return decodeKey(values.key);
  if (values["key-file"] !== undefined) {
    const text = new TextDecoder().decode(await readInput(userPath(config, values["key-file"])));
    return decodeKey(text);
  }
  return null;
}

/**
 * Where `get` and `verify` read from: one explicit gateway, or the configured storage
 * (local directory first, then the configured gateway).
 * @param {import("../config.js").OracleConfig} config
 * @param {string|undefined} gatewayUrl value of --gateway
 * @returns {{ name?: string, baseUrl?: string, get: (cid: string) => Promise<Uint8Array> }}
 */
function source(config, gatewayUrl) {
  if (gatewayUrl === undefined) return createStorage(config);
  try {
    return new GatewayClient({ baseUrl: gatewayUrl });
  } catch (error) {
    throw new UsageError(`--gateway: ${error.message}`);
  }
}

/**
 * If the bytes are one of the project's JSON documents, say which and whether it is valid.
 * @param {import("../config.js").OracleConfig} config
 * @param {Uint8Array} bytes
 * @returns {string|null} a one-line note, or null when the bytes are not a recognisable document
 */
function describeDocument(config, bytes) {
  const documents = createDocuments({ schemasDir: config.paths.schemasDir });
  try {
    const { type, document } = documents.parse(bytes);
    return `${type} v${document.schemaVersion}, valid against its schema`;
  } catch (error) {
    if (!(error instanceof DocumentValidationError)) throw error;
    // Only comment on files that claim to be one of our documents; other content (attachments, envelopes) is not an error.
    return documents.types.includes(error.documentType) ? `${error.documentType}, but INVALID against its schema (run "validate" for details)` : null;
  }
}
