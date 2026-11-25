/**
 * Plain-language messages for everything that can go wrong when the app talks
 * to the contract, a wallet or the file service.
 *
 * The contract reverts with custom errors that carry the values needed to
 * explain them (see the "Errors" section of contracts/README.md).
 * CONTRACT_ERROR_MESSAGES below is the one table that turns each of them into
 * a sentence; a unit test checks that it covers every error in the ABI, so a
 * new contract error cannot reach a person as raw hex.
 *
 * The app simulates every transaction before sending it, so these messages are
 * normally shown instead of a failed transaction, not after one.
 */

import { roleLabelFromId, statusLabel } from "./constants.js";
import { formatTemperature, shortAddress } from "./format.js";

/**
 * One sentence per custom error. Each entry receives the error's arguments as
 * an object keyed by the parameter names in the ABI.
 * @type {Record<string, (args: Record<string, any>) => string>}
 */
export const CONTRACT_ERROR_MESSAGES = Object.freeze({
  AccessControlUnauthorizedAccount: ({ neededRole }) =>
    `This account does not hold the ${roleLabelFromId(neededRole)} role, which this action needs. Ask the regulator to grant it.`,
  AccessControlBadConfirmation: () =>
    "A role can only be given up by the account that holds it. To remove a role from another account, the regulator revokes it.",
  MissingEitherRole: ({ roleA, roleB }) =>
    `This account holds neither the ${roleLabelFromId(roleA)} nor the ${roleLabelFromId(roleB)} role, and this action needs one of them.`,
  ZeroAddress: () => "The regulator address cannot be the zero address.",
  BatchNotFound: ({ batchId }) => `Lot #${batchId} does not exist in this registry.`,
  ZeroProductHash: () => "The product code and lot number are missing.",
  DuplicateProduct: ({ existingBatchId }) =>
    `This product code and lot number are already registered as lot #${existingBatchId}. A lot can be registered only once.`,
  InvalidTimestamp: () => "The date is missing or lies in the future according to the blockchain's clock.",
  InvalidTemperatureRange: ({ minTempTenthsC, maxTempTenthsC }) =>
    `The allowed temperature range is not valid: the lowest temperature (${formatTemperature(Number(minTempTenthsC))}) ` +
    `must be below the highest (${formatTemperature(Number(maxTempTenthsC))}).`,
  EmptyDocument: () => "The document reference is empty. Upload the document first, then try again.",
  NotCustodian: ({ batchId }) => `This account does not hold lot #${batchId}, so it cannot act on it.`,
  NotPendingCustodian: ({ batchId }) =>
    `The open hand-off of lot #${batchId} names a different recipient, so this account cannot accept it.`,
  TransferAlreadyPending: ({ batchId, pendingCustodian }) =>
    `Lot #${batchId} already has an open hand-off to ${shortAddress(pendingCustodian)}. It must be accepted or cancelled first.`,
  // The dashboard offers Accept and Cancel only for an open hand-off, so this means the other side acted first.
  NoPendingTransfer: ({ batchId }) =>
    `Lot #${batchId} has no open hand-off. It may have been accepted or cancelled in the meantime.`,
  InvalidRecipient: ({ to }) =>
    `${shortAddress(to)} cannot receive this lot. A manufacturer hands a lot to a distributor; a distributor hands it to ` +
    "another distributor or to a pharmacy; nobody hands a lot to themselves.",
  InvalidStatus: ({ batchId, current }) =>
    `This is not possible while lot #${batchId} is ${statusLabel(Number(current)).toLowerCase()}.`,
  InvalidStatusTransition: ({ batchId, from, to }) =>
    `Lot #${batchId} cannot go from ${statusLabel(Number(from)).toLowerCase()} to ${statusLabel(Number(to)).toLowerCase()}. ` +
    "A distributor can only switch a lot between in transit and stored.",
  ReadingWithinRange: ({ readingTenthsC, minTempTenthsC, maxTempTenthsC }) =>
    `A reading of ${formatTemperature(Number(readingTenthsC))} is inside the allowed range ` +
    `(${formatTemperature(Number(minTempTenthsC))} to ${formatTemperature(Number(maxTempTenthsC))}), so it is not an excursion.`,
  EmptyReason: () => "A recall needs a reason.",
});

/**
 * Error codes of the shared oracle modules whose messages are already written for the person at the screen.
 * SERVICE_REQUEST_FAILED is one too, but explainError adjusts its start-up advice first.
 */
const READABLE_ERROR_CODES = new Set([
  "CONTENT_INTEGRITY",
  "CONTENT_TOO_LARGE",
  "CONTENT_INVALID",
  "CID_INVALID",
]);

/** ethers error codes that mean the node could not be reached or did not answer properly. */
const NODE_UNREACHABLE_CODES = new Set(["NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT"]);

/**
 * The advice that the shared upload-service client (oracle/src/service/client.js)
 * ends its "cannot be reached" message with, and the same advice with the
 * folder the command runs in, which a person at the web app does not know.
 */
const SERVICE_START_ADVICE = 'Start it with "npm run service".';
const SERVICE_START_ADVICE_WITH_FOLDER = 'Start it in the oracle/ folder with "npm run service".';

/**
 * An error whose message is already a complete sentence for the person at the
 * screen. Code that detects a problem itself (a file that is too large, a lot
 * that is already registered) throws this, and explainError passes the
 * message through unchanged.
 */
export class UserMessageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UserMessageError";
  }
}

/**
 * The sentence for a contract custom error.
 *
 * @param {string} name                 the error's name, for example "NotCustodian"
 * @param {Record<string, any>} [args]  its arguments by parameter name
 * @returns {string|null} null when the name is not one of the contract's errors
 */
export function describeContractError(name, args = {}) {
  const describe = CONTRACT_ERROR_MESSAGES[name];
  return describe ? describe(args) : null;
}

/**
 * Turn anything that was thrown into one sentence for the person at the screen.
 *
 * Understands, in this order: a message already written for the person, a
 * decoded contract revert (ethers puts it in `error.revert`), a request
 * declined in the wallet, an unreachable node, and the typed errors of the
 * shared oracle modules. Anything else is reported as unexpected with the
 * first line of its message.
 *
 * @param {any} error
 * @returns {string}
 */
export function explainError(error) {
  if (error instanceof UserMessageError) return error.message;

  const revert = error?.revert;
  if (typeof revert?.name === "string") {
    const sentence = describeContractError(revert.name, namedArguments(revert.args));
    if (sentence) return sentence;
    return `The contract refused this action (${revert.name}).`;
  }

  const code = error?.code;
  // ethers reports a declined wallet request as ACTION_REJECTED; a wallet asked directly answers with EIP-1193 code 4001.
  if (code === "ACTION_REJECTED" || code === 4001) return "The request was declined in the wallet, so nothing was sent.";
  if (code === "INSUFFICIENT_FUNDS") return "This account does not have enough funds to pay the transaction fee.";
  if (code === "CALL_EXCEPTION") return "The contract refused this action without giving a reason.";
  if (NODE_UNREACHABLE_CODES.has(code) || isFailedFetch(error)) {
    return "The blockchain node did not answer. Check that it is running, then try again.";
  }
  if (code === "SERVICE_REQUEST_FAILED") {
    // The folder is added inside the client's own sentence rather than as a second instruction after it.
    // Any other wording of the client's message is passed on unchanged.
    return String(error.message).replace(SERVICE_START_ADVICE, SERVICE_START_ADVICE_WITH_FOLDER);
  }
  if (code === "ENVELOPE_UNAVAILABLE") {
    // Browsers offer WebCrypto only to https pages and to localhost. In the demo this happens on the
    // plain-http network address that `npm start -- --lan` prints, so say where the same page works.
    const port = globalThis.location?.port;
    const localAddress = `http://localhost${port ? `:${port}` : ""}`;
    return (
      "This browser encrypts and decrypts files only on pages opened over https or on localhost, and this page was " +
      `opened over plain http through a network address. Open it on the laptop that runs the demo, at ${localAddress}, ` +
      "and try again there."
    );
  }
  if (READABLE_ERROR_CODES.has(code) || String(code).startsWith("ENVELOPE_")) return error.message;
  if (code === "DOCUMENT_INVALID") {
    // The form checks should catch this first; if not, list what the schema rejected.
    const problems = (error.errors ?? []).map((problem) => `${problem.path} ${problem.message}`).join("; ");
    return `The document could not be built: ${problems || "it does not match its schema"}.`;
  }

  const firstLine = String(error?.shortMessage ?? error?.message ?? error).split("\n")[0].slice(0, 200);
  return `Something unexpected went wrong: ${firstLine}`;
}

/**
 * Tell whether an error is the browser's report of a request that got no
 * answer. Browsers throw a TypeError for that, each with its own wording
 * ("Failed to fetch", "Load failed", "NetworkError when attempting to fetch
 * resource"); other TypeErrors are programming mistakes and must not be
 * blamed on the node.
 * @param {any} error
 * @returns {boolean}
 */
function isFailedFetch(error) {
  return error instanceof TypeError && /fetch|load failed|networkerror/i.test(error.message);
}

/**
 * Arguments of a decoded revert as a plain object. ethers delivers a Result,
 * which is array-like and offers toObject(); tests pass a plain object.
 * @param {any} args
 * @returns {Record<string, any>}
 */
function namedArguments(args) {
  if (typeof args?.toObject === "function") {
    try {
      return args.toObject();
    } catch {
      // toObject throws when a parameter has no name; none of this contract's errors has one.
      return {};
    }
  }
  return args ?? {};
}
