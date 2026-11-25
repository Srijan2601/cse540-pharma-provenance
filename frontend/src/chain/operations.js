/**
 * The things an organization does through the dashboard, as functions that
 * either complete or throw.
 *
 * Every transaction goes through sendTransaction, which first simulates the
 * call with the signer's address (an eth_call, which costs nothing). If the
 * contract would revert, the simulation throws the decoded custom error and
 * nothing is sent, so nobody pays for or waits on a transaction that is known
 * to fail. Callers turn whatever is thrown into a sentence with
 * explainError (lib/errors.js).
 *
 * Operations that involve a document follow the same order every time:
 * build the document, upload its exact bytes, check the returned fingerprint,
 * and only then put the reference on-chain.
 */

import { decrypt, encodeKey, encrypt, generateKey } from "@oracle/crypto/envelope.js";

import { buildAttachment, documentBuilders } from "../lib/documents.js";
import { describeContractError, UserMessageError } from "../lib/errors.js";
import { buildCertificateFields, buildLotRegistration, describeAttachment, exceedsUploadLimit } from "../lib/forms.js";
import { formatBytes } from "../lib/format.js";
import { readFileServiceHealth, uploadBytes } from "./files.js";
import { getRegistry } from "./provider.js";
import { readChainTime } from "./registry.js";

/**
 * Simulate a contract call and, if it would succeed, send it and wait for it to be mined.
 *
 * @param {import("ethers").Contract} registry the registry connected to a signer
 * @param {string} method                       function name, for example "acceptTransfer"
 * @param {unknown[]} args                      its arguments
 * @returns {Promise<import("ethers").ContractTransactionReceipt>}
 * @throws the decoded revert when the simulation fails (nothing is sent), or the wallet's or node's error
 */
export async function sendTransaction(registry, method, args) {
  await registry[method].staticCall(...args);
  const transaction = await registry[method](...args);
  const receipt = await transaction.wait();
  if (receipt === null || receipt.status !== 1) {
    // Possible only if the state changed between the simulation and the block that included the transaction.
    throw new UserMessageError("The transaction was included in a block but failed. The lot may have changed in the meantime; check it and try again.");
  }
  return receipt;
}

/**
 * Upload a built document and make sure the service stored exactly what was built.
 *
 * @param {{ bytes: Uint8Array, contentHash: string }} built output of a document builder
 * @param {string} name file name label
 * @returns {Promise<{ cid: string, contentHash: string }>} the DocumentRef for the contract call
 */
async function uploadDocument(built, name) {
  const stored = await uploadBytes(built.bytes, name);
  // The upload client already compares the service's answer with the bytes it sent. Comparing it
  // with the builder's own hash as well ties the on-chain reference to the document that was built.
  if (stored.contentHash !== built.contentHash) {
    throw new UserMessageError("The file service returned a fingerprint that does not belong to the document. Nothing was recorded.");
  }
  return { cid: stored.cid, contentHash: stored.contentHash };
}

/**
 * Register a new lot: optional attachment, lot metadata, then registerBatch.
 *
 * @param {object} input
 * @param {import("../lib/networks.js").Network} input.network
 * @param {import("ethers").Signer} input.signer            the manufacturer
 * @param {typeof import("../lib/forms.js").EMPTY_LOT_FORM} input.form a form that passed validateLotForm
 * @param {File|null} input.file                             the optional attachment
 * @param {boolean} input.encryptFile                        encrypt the attachment before upload
 * @param {(step: string) => void} input.report              called with a short description of each step
 * @returns {Promise<{ lotId: number, attachmentKey: string|null }>}
 *   `attachmentKey` is the key of an encrypted attachment in its text form. It exists only in this
 *   return value: it is never uploaded, stored or put on-chain.
 */
export async function registerLot({ network, signer, form, file, encryptFile, report }) {
  const registry = getRegistry(network, signer);

  report("Checking the lot against the registry");
  const chainNow = await readChainTime(network);
  const { productHash } = buildLotRegistration(form, { chainId: network.chainId, registry: network.registry, chainNow });
  // Checked before anything is uploaded, so a lot that cannot be registered leaves no stray files behind.
  const existingLotId = await registry.batchIdOf(productHash);
  if (existingLotId !== 0n) {
    throw new UserMessageError(describeContractError("DuplicateProduct", { existingBatchId: existingLotId }));
  }

  const attachments = [];
  let attachmentKey = null;
  if (file) {
    const { maxUploadBytes } = await readFileServiceHealth();
    if (exceedsUploadLimit(file.size, encryptFile, maxUploadBytes)) {
      throw new UserMessageError(`The attachment is larger than the file service accepts (${formatBytes(maxUploadBytes)}).`);
    }
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) throw new UserMessageError("The attachment is an empty file.");
    if (encryptFile) {
      report("Encrypting the attachment in the browser");
      const key = generateKey();
      bytes = await encrypt(bytes, key);
      attachmentKey = encodeKey(key);
    }
    report("Uploading the attachment");
    // The fingerprint in the metadata covers the uploaded bytes: for a confidential file, the ciphertext.
    const stored = await uploadBytes(bytes, encryptFile ? `${file.name}.enc` : file.name);
    attachments.push(buildAttachment(describeAttachment({ fileName: file.name, fileType: file.type, encrypted: encryptFile, stored })));
  }

  report("Uploading the lot metadata");
  const registration = buildLotRegistration(form, { chainId: network.chainId, registry: network.registry, chainNow, attachments });
  const metadata = await uploadDocument(documentBuilders.buildLotMetadata(registration.metadataFields), "lot-metadata.json");

  report("Registering the lot on the blockchain");
  const receipt = await sendTransaction(registry, "registerBatch", [
    registration.productHash,
    registration.manufactureDate,
    registration.minTempTenthsC,
    registration.maxTempTenthsC,
    metadata,
  ]);

  // The new id is taken from the BatchRegistered event of this very transaction.
  const registered = receipt.logs.map((log) => registry.interface.parseLog(log)).find((event) => event?.name === "BatchRegistered");
  return { lotId: Number(registered.args.batchId), attachmentKey };
}

/**
 * Issue a regulator certificate: build the document, upload it, then issueCertificate.
 *
 * @param {object} input
 * @param {import("../lib/networks.js").Network} input.network
 * @param {import("ethers").Signer} input.signer            the regulator
 * @param {{ id: number, productHash: string }} input.lot
 * @param {typeof import("../lib/forms.js").EMPTY_CERTIFICATE_FORM} input.form a form that passed validateCertificateForm
 * @param {(step: string) => void} input.report
 * @returns {Promise<void>}
 */
export async function issueCertificate({ network, signer, lot, form, report }) {
  const registry = getRegistry(network, signer);
  report("Uploading the certificate");
  const fields = buildCertificateFields(form, {
    chainId: network.chainId,
    registry: network.registry,
    lot,
    issuedAt: await readChainTime(network),
  });
  const certificate = await uploadDocument(documentBuilders.buildRegulatorCertificate(fields), `certificate-lot-${lot.id}.json`);
  report("Recording the certificate on the blockchain");
  await sendTransaction(registry, "issueCertificate", [lot.id, certificate]);
}

/**
 * Decrypt a confidential attachment with a key the person pasted.
 *
 * @param {Uint8Array} envelope the attachment's bytes as downloaded (already checked against their fingerprint)
 * @param {string} keyText      the key in its 43-character text form
 * @returns {Promise<Uint8Array>} the original file
 * @throws {Error} with a message for the person when the key is malformed or wrong
 */
export function decryptAttachment(envelope, keyText) {
  return decrypt(envelope, keyText.trim());
}
