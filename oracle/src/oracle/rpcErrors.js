/**
 * Classification of failed JSON-RPC requests, for the registry client.
 *
 * A request to the chain can fail in three different ways, and the oracle
 * must react differently to each:
 *
 *   transient      the endpoint was unreachable, timed out, answered with a
 *                  server error or reported overload. Trying again may work.
 *   node refusal   the node answered with an error of its own that will not
 *                  go away (a malformed request, an unsupported method).
 *   revert         the contract executed the call and rejected it. That is
 *                  decoded in revert.js, not here.
 *
 * The functions here look only at the error object ethers threw. They also
 * build the short failure text shown to the operator, which must never
 * contain the RPC URL: a provider's URL often carries an API key.
 *
 * No network access and no state.
 */

import { extractRevertData } from "./revert.js";

/** ethers error codes and Node.js socket error codes that mean "the endpoint could not be reached or answered badly". */
const TRANSIENT_CODES = new Set([
  "NETWORK_ERROR",
  "TIMEOUT",
  "SERVER_ERROR",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** JSON-RPC error texts with which public nodes report overload or a backend that lags behind. */
const TRANSIENT_RPC_MESSAGE = /rate limit|too many requests|timed? ?out|header not found|try again|temporar|overloaded|busy|internal error/i;

/** Node answers that mean "a transaction with this nonce is already waiting in the mempool". */
const ALREADY_PENDING_MESSAGE = /already known|known transaction|already imported|already exists|replacement transaction underpriced/i;

/**
 * The message of the JSON-RPC error object inside an ethers error, if there is one.
 * @param {any} error
 * @returns {string|null}
 */
export function rpcErrorMessage(error) {
  const message = error?.error?.message ?? error?.info?.error?.message;
  return typeof message === "string" ? message : null;
}

/**
 * Tell whether the NODE refused a request, as opposed to the contract
 * reverting it.
 *
 * ethers turns every JSON-RPC error answer to eth_call and eth_estimateGas
 * into a CALL_EXCEPTION, because that is how a revert arrives. A public
 * endpoint also answers those methods with errors of its own ("rate limit
 * exceeded", "header not found"), which must not be reported as "the
 * contract rejected the call". The two are told apart by the answer itself:
 * a revert carries revert data or says "revert"; a refusal does neither.
 *
 * @param {any} error
 * @returns {boolean}
 */
export function isNodeRefusal(error) {
  const rpcMessage = rpcErrorMessage(error);
  if (rpcMessage === null || /revert/i.test(rpcMessage)) return false;
  return (error?.code === "UNKNOWN_ERROR" || error?.code === "CALL_EXCEPTION") && extractRevertData(error) === null;
}

/**
 * Tell whether a failure is one that a retry may cure: the endpoint was
 * unreachable, timed out, answered with a server error, or reported overload.
 * @param {any} error
 * @returns {boolean}
 */
export function isTransientFailure(error) {
  if (TRANSIENT_CODES.has(error?.code) || TRANSIENT_CODES.has(error?.cause?.code)) return true;
  // Node's fetch reports a failed connection as TypeError("fetch failed").
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  // A proxy or gateway answered with a non-JSON error page.
  if (error?.code === "UNSUPPORTED_OPERATION" && /not valid JSON/i.test(error.shortMessage ?? "")) return true;
  return isNodeRefusal(error) && TRANSIENT_RPC_MESSAGE.test(rpcErrorMessage(error));
}

/**
 * Tell whether the node refused a transaction because one with the same nonce is already in its mempool.
 * @param {any} error
 * @returns {boolean}
 */
export function isAlreadyPending(error) {
  if (error?.code === "REPLACEMENT_UNDERPRICED") return true;
  const rpcMessage = rpcErrorMessage(error);
  return rpcMessage !== null && ALREADY_PENDING_MESSAGE.test(rpcMessage);
}

/**
 * A short description of a failure for a message shown to the operator.
 *
 * ethers' full `message` can embed the request URL, and an RPC URL may
 * contain an API key. So the description is built from the node's own error
 * text or ethers' short message, and is passed through the scrubber as well.
 *
 * @param {any} error
 * @param {(text: string) => string} scrub from createScrubber()
 * @returns {string} one line, at most 300 characters, without a trailing full stop
 */
export function describeFailure(error, scrub) {
  const text = rpcErrorMessage(error) ?? error?.shortMessage ?? error?.message ?? String(error);
  return scrub(String(text)).replace(/\s+/g, " ").trim().replace(/[.]+$/, "").slice(0, 300);
}

/**
 * Build a function that removes the RPC URL, and the parts of it that may
 * hold a credential (path, query string, user and password), from a text.
 * @param {string} rpcUrl
 * @returns {(text: string) => string}
 */
export function createScrubber(rpcUrl) {
  const secrets = [rpcUrl];
  try {
    const url = new URL(rpcUrl);
    const tail = `${url.pathname}${url.search}`;
    // "/" alone is not a secret, and replacing it would mangle every message.
    if (tail.length > 1) secrets.push(tail);
    if (url.username !== "" || url.password !== "") secrets.push(`${url.username}:${url.password}`);
  } catch {
    // The configuration module already validated the URL; nothing more to hide if it cannot be parsed.
  }
  return (text) => secrets.reduce((result, secret) => result.split(secret).join("[hidden]"), text);
}
