/**
 * Typed errors shared by the Node-side modules of the oracle package.
 *
 * Every failure a caller may want to handle differently has its own class, so
 * callers branch with `instanceof` (or the stable `code` string) instead of
 * parsing messages. The upload service maps these classes to HTTP status
 * codes, the command-line tools map them to exit codes, and the oracle runner
 * retries only the failures that are marked transient (TransientChainError,
 * and a StorageError whose `transient` flag is set).
 *
 * Messages are written for the person running the demo: they say what went
 * wrong and what to do about it. They never contain secret values.
 *
 * (src/crypto/envelope.js defines its own EnvelopeError on purpose: that file
 * has no imports so the browser dApp can reuse it as a single file.)
 */

/** Base class: gives every error of this package a stable machine-readable `code`. */
export class OracleError extends Error {
  /**
   * @param {string} message human-readable, actionable description
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, { code = "ORACLE_ERROR", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
  }
}

/** One or more environment variables are missing or invalid. */
export class ConfigError extends OracleError {
  /**
   * @param {string[]} problems one line per invalid variable; never includes a secret value
   */
  constructor(problems) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`, {
      code: "CONFIG_INVALID",
    });
    this.problems = problems;
  }
}

/** A string is not a well-formed CID that this package supports. */
export class InvalidCidError extends OracleError {
  /** @param {string} message */
  constructor(message) {
    super(message, { code: "CID_INVALID" });
  }
}

/** The content for a CID is not in the local store (and not on the gateway, if one is configured). */
export class NotFoundError extends OracleError {
  /**
   * @param {string} cid
   * @param {string} [where] where it was looked for, for the message
   */
  constructor(cid, where = "the local store") {
    super(`No content for CID ${cid} in ${where}.`, { code: "CONTENT_NOT_FOUND" });
    this.cid = cid;
  }
}

/**
 * Bytes do not match the digest inside their CID. The content was corrupted or
 * swapped, so it must not be used or served.
 */
export class IntegrityError extends OracleError {
  /**
   * @param {string} cid
   * @param {string} source who delivered the bad bytes (for example "the local store")
   */
  constructor(cid, source) {
    super(
      `Content from ${source} does not match the sha2-256 digest in CID ${cid}. ` +
        "It was corrupted or replaced and has been rejected.",
      { code: "CONTENT_INTEGRITY" },
    );
    this.cid = cid;
  }
}

/** An upload is larger than the limit that applies to it. */
export class ContentTooLargeError extends OracleError {
  /**
   * @param {number} limit the limit in bytes
   * @param {string} [detail] what the limit protects, for the message
   */
  constructor(limit, detail = "") {
    super(`Content is larger than the ${limit}-byte limit${detail ? ` (${detail})` : ""}.`, {
      code: "CONTENT_TOO_LARGE",
    });
    this.limit = limit;
  }
}

/** The content cannot be stored as given (for example it is empty or not a byte array). */
export class InvalidContentError extends OracleError {
  /** @param {string} message */
  constructor(message) {
    super(message, { code: "CONTENT_INVALID" });
  }
}

/**
 * A storage backend or gateway failed: unreachable, timed out, or it answered
 * with something unexpected. `backend` names the component ("kubo", "pinata",
 * "gateway", "local").
 */
export class StorageError extends OracleError {
  /**
   * @param {string} backend
   * @param {string} message
   * @param {{ status?: number, cause?: unknown, transient?: boolean }} [options] `status` is the remote HTTP
   *        status, if there was one. `transient` says whether trying again may succeed; when omitted it follows
   *        from the status (408, 429 and 5xx are transient, everything else is not).
   */
  constructor(backend, message, { status, cause, transient } = {}) {
    super(message, { code: "STORAGE_FAILED", cause });
    this.backend = backend;
    this.status = status;
    /** True when the failure is worth a retry (service unreachable, timeout, overload). The oracle retries only these. */
    this.transient = transient ?? (status === 408 || status === 429 || (typeof status === "number" && status >= 500));
  }
}

/** A document does not match its JSON Schema or the cross-field rules. */
export class DocumentValidationError extends OracleError {
  /**
   * @param {string} documentType for example "sensor-log", or "unknown"
   * @param {{ path: string, message: string }[]} errors every problem found, not just the first
   */
  constructor(documentType, errors) {
    super(
      `Invalid ${documentType} document:\n${errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n")}`,
      { code: "DOCUMENT_INVALID" },
    );
    this.documentType = documentType;
    this.errors = errors;
  }
}

/** The upload service answered a client request with an error status, or could not be reached. */
export class ServiceRequestError extends OracleError {
  /**
   * @param {string} message
   * @param {{ status?: number, cause?: unknown }} [options] `status` is the HTTP status, if a response arrived
   */
  constructor(message, { status, cause } = {}) {
    super(message, { code: "SERVICE_REQUEST_FAILED", cause });
    this.status = status;
  }
}

/** The command line was used incorrectly (unknown command, missing argument, unreadable file). */
export class UsageError extends OracleError {
  /** @param {string} message */
  constructor(message) {
    super(message, { code: "USAGE" });
  }
}

/** The sensor simulator was asked for something it cannot produce (unknown scenario, unusable range or window). */
export class SimulationError extends OracleError {
  /** @param {string} message */
  constructor(message) {
    super(message, { code: "SIMULATION_INVALID" });
  }
}

/**
 * The deployment record or the ABI the oracle needs is missing or unusable.
 * `code` is DEPLOYMENT_MISSING when a file does not exist and
 * DEPLOYMENT_INVALID when it exists but cannot be used.
 */
export class DeploymentError extends OracleError {
  /**
   * @param {string} message says which file, and which command creates it
   * @param {{ missing?: boolean, cause?: unknown }} [options]
   */
  constructor(message, { missing = false, cause } = {}) {
    super(message, { code: missing ? "DEPLOYMENT_MISSING" : "DEPLOYMENT_INVALID", cause });
  }
}

/**
 * A pre-flight check failed, so the oracle must not start. `check` names it:
 * "rpc", "chain-id", "code", "signer" or "role".
 */
export class PreflightError extends OracleError {
  /**
   * @param {"rpc"|"chain-id"|"code"|"signer"|"role"} check
   * @param {string} message what is wrong and how to fix it
   * @param {{ cause?: unknown }} [options]
   */
  constructor(check, message, { cause } = {}) {
    super(message, { code: "PREFLIGHT_FAILED", cause });
    this.check = check;
  }
}

/** A call to the chain failed for good: retrying the same call would fail the same way. */
export class ChainError extends OracleError {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, { code = "CHAIN_FAILED", cause } = {}) {
    super(message, { code, cause });
  }
}

/**
 * A call to the chain failed in a way that may pass on a retry: the RPC
 * endpoint is unreachable, timed out or overloaded, or a transaction is not
 * mined yet. `txHash` is set when a transaction was broadcast before the
 * failure, so its outcome is still open.
 */
export class TransientChainError extends ChainError {
  /**
   * @param {string} message
   * @param {{ txHash?: string|null, cause?: unknown }} [options]
   */
  constructor(message, { txHash = null, cause } = {}) {
    super(message, { code: "CHAIN_UNAVAILABLE", cause });
    this.txHash = txHash;
  }
}

/**
 * The contract rejected a call. `errorName` is the Solidity custom error
 * (for example "InvalidStatus"), `args` its decoded arguments by name, and
 * `detail` the readable form, for example "InvalidStatus(batchId=2, current=Compromised)".
 */
export class ContractRevertError extends ChainError {
  /**
   * @param {object} revert
   * @param {string} revert.errorName       custom error name, "Error" for a revert string, "Panic", or "unknown"
   * @param {Record<string, unknown>} [revert.args] decoded arguments keyed by parameter name
   * @param {string} revert.detail          one-line readable form of the error and its arguments
   * @param {string} [revert.explanation]   what the error means for the oracle, if known
   * @param {string|null} [revert.data]     the raw revert data
   * @param {{ cause?: unknown }} [options]
   */
  constructor({ errorName, args = {}, detail, explanation = "", data = null }, { cause } = {}) {
    super(`The contract rejected the call: ${detail}${explanation ? ` (${explanation})` : ""}.`, { code: "CONTRACT_REVERT", cause });
    this.errorName = errorName;
    this.args = args;
    this.detail = detail;
    this.data = data;
  }
}

/**
 * The account nonce reserved for a transaction has been used. Either an
 * earlier attempt of the same transaction was mined, or another process is
 * sending from the oracle account.
 */
export class NonceConsumedError extends ChainError {
  /**
   * @param {number} nonce
   * @param {{ cause?: unknown }} [options]
   */
  constructor(nonce, { cause } = {}) {
    super(`Account nonce ${nonce} has already been used.`, { code: "NONCE_CONSUMED", cause });
    this.nonce = nonce;
  }
}

/** The registry has no lot with this id (the contract's BatchNotFound). */
export class LotNotFoundError extends ChainError {
  /** @param {number} lotId */
  constructor(lotId) {
    super(`Lot ${lotId} does not exist in the registry.`, { code: "LOT_NOT_FOUND" });
    this.lotId = lotId;
  }
}
