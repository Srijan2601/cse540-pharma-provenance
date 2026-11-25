/**
 * Off-chain files: uploading through the upload service of oracle/, and
 * downloading from the gateway with the integrity check that is the point of
 * the whole project.
 *
 * Uploading goes through the service (design decision O3) so that no storage
 * credential ever reaches the browser. The shared UploadServiceClient
 * re-computes keccak256 of the bytes it sent and refuses an answer whose
 * contentHash differs, so the hash that later goes on-chain is one the
 * browser computed itself.
 *
 * Downloading trusts nothing: the bytes a gateway returns are hashed here and
 * compared with the fingerprint from the chain (design decision O1). A file is
 * reported as matching, not matching, or unavailable, and only matching bytes
 * are handed on to be parsed.
 */

import { isCid, parseCid, verifyContent } from "@oracle/ipfs/cid.js";
import { UploadServiceClient } from "@oracle/service/client.js";

import { config } from "../config.js";

/** Give up on a download after this long; a phone on a weak connection should get an answer, not a spinner. */
const DOWNLOAD_TIMEOUT_MS = 20000;

/**
 * Largest download accepted, the hard upper limit of the upload service
 * (UPLOAD_HARD_MAX_BYTES in oracle/src/config.js). The documents of this
 * project are a few kilobytes; a gateway offering far more is not serving them.
 */
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

const uploadService = new UploadServiceClient({
  baseUrl: config.uploadServiceUrl,
  // The client stores the function and calls it as a method of itself, which browsers reject for
  // the built-in fetch ("Illegal invocation"); the wrapper calls fetch the way the browser expects.
  fetch: (input, init) => fetch(input, init),
});

/**
 * Ask the upload service whether it is running.
 * @returns {Promise<{ ok: boolean, backend: string, maxUploadBytes: number }>}
 * @throws {Error} with a message for the person when the service cannot be reached
 */
export function readFileServiceHealth() {
  return uploadService.health();
}

/**
 * Upload bytes exactly as given.
 *
 * @param {Uint8Array} bytes the bytes to store; for a document, the builder's output, never re-serialized
 * @param {string} name      file name label for the service's log
 * @returns {Promise<{ cid: string, contentHash: string, size: number }>} the reference to put on-chain
 * @throws {Error} when the service refuses the upload, cannot be reached, or answers with a hash, size
 *         or CID that does not belong to the bytes sent
 */
export function uploadBytes(bytes, name) {
  return uploadService.add(bytes, { name });
}

/**
 * The gateway address of a file. Built only from a CID that parses, so a
 * value read from the chain or from a document can never inject a path or
 * another host into the URL.
 *
 * @param {string} cid
 * @returns {string|null} null when the text is not a well-formed CID
 */
export function gatewayUrlFor(cid) {
  return isCid(cid) ? `${config.gatewayUrl}${parseCid(cid).text}` : null;
}

/**
 * @typedef {object} FileCheck
 * @property {"match"|"mismatch"|"unavailable"} status
 * @property {Uint8Array} [bytes]   the downloaded bytes; present only when status is "match"
 * @property {string} [reason]      what went wrong, for "mismatch" and "unavailable"
 */

/**
 * Results of finished checks. A match or a mismatch is final for this page
 * load (reloading the page checks again); "unavailable" is not kept, so the
 * next refresh of the page tries again.
 * @type {Map<string, Promise<FileCheck>>}
 */
const checks = new Map();

/**
 * Download a file and compare it with its recorded fingerprint.
 *
 * @param {{ cid: string, contentHash: string }} ref the reference from the chain (or from verified lot metadata)
 * @returns {Promise<FileCheck>} never rejects
 */
export function checkFile(ref) {
  const key = `${ref.cid}|${ref.contentHash}`;
  let check = checks.get(key);
  if (!check) {
    check = downloadAndVerify(ref);
    checks.set(key, check);
    check.then((result) => {
      if (result.status === "unavailable") checks.delete(key);
    });
  }
  return check;
}

/**
 * @param {{ cid: string, contentHash: string }} ref
 * @returns {Promise<FileCheck>}
 */
async function downloadAndVerify(ref) {
  const url = gatewayUrlFor(ref.cid);
  if (url === null) return { status: "unavailable", reason: "The recorded reference is not a valid IPFS address." };

  let response;
  try {
    // no-store: a verifier must look at what the gateway serves now, not at a copy the browser kept.
    response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch {
    return { status: "unavailable", reason: "The file gateway did not answer." };
  }

  if (!response.ok) {
    const gatewayMessage = await readGatewayError(response);
    // The project's own gateway re-hashes every file it serves and answers 500 when its stored copy
    // no longer matches the CID. That is a changed file, detected one hop earlier, so it is reported
    // as a mismatch. Any other refusal just means the file could not be had.
    if (response.status === 500 && /integrity/i.test(gatewayMessage)) {
      return { status: "mismatch", reason: "The gateway reports that its stored copy was changed and refused to serve it." };
    }
    return {
      status: "unavailable",
      reason: response.status === 404 ? "The gateway does not have this file." : `The gateway answered with error ${response.status}.`,
    };
  }

  if (Number(response.headers.get("Content-Length") ?? 0) > MAX_DOWNLOAD_BYTES) {
    return { status: "unavailable", reason: "The gateway offered a file that is far too large to be this document." };
  }

  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { status: "unavailable", reason: "The download was interrupted." };
  }

  // keccak256 of the exact bytes against the recorded contentHash is the authoritative check.
  const report = verifyContent(bytes, ref);
  return report.contentHash.matches
    ? { status: "match", bytes }
    : { status: "mismatch", reason: "The downloaded bytes do not hash to the recorded fingerprint." };
}

/**
 * Read the { error } message of a gateway error answer.
 * @param {Response} response
 * @returns {Promise<string>} empty when the answer carries no readable message
 */
async function readGatewayError(response) {
  try {
    const body = await response.json();
    return typeof body?.error === "string" ? body.error : "";
  } catch {
    return "";
  }
}
