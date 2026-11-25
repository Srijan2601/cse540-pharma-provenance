/**
 * The "Documents" section of the verify page: every file of the lot with the
 * result of its fingerprint check.
 *
 * For each file the page downloaded the bytes from the gateway, hashed them
 * with keccak256 and compared the result with the hash recorded on the
 * blockchain (for an attachment: with the hash recorded in the verified
 * document that lists it). The three outcomes are spelled out in words:
 * matches, DOES NOT MATCH, could not be fetched.
 *
 * A confidential attachment is an encrypted file. Its fingerprint covers the
 * encrypted bytes, so its integrity is checked like any other file's; reading
 * it needs the key, which the page accepts in a field and uses only in the
 * browser.
 */

import { useState } from "react";

import { gatewayUrlFor } from "../../chain/files.js";
import { decryptAttachment } from "../../chain/operations.js";
import { explainError } from "../../lib/errors.js";
import { formatBytes, formatDate, kebabToWords } from "../../lib/format.js";
import { Field } from "../Field.jsx";
import { Icon } from "../Icon.jsx";
import { Notice } from "../Notice.jsx";

/**
 * Hand bytes to the browser as a file download.
 *
 * The download is always typed as a generic binary file, whatever the
 * attachment claims to be, so the browser saves it instead of rendering it:
 * an attachment is untrusted content and must never run as a page of this app.
 *
 * @param {Uint8Array} bytes
 * @param {string} name the file name suggested to the browser
 */
function saveFile(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  // The name comes from a document written by another organization; keep only characters that are safe in a file name.
  link.download = name.replace(/[^\w.\- ()]/g, "_") || "attachment";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * The line that states the result of a file's fingerprint check.
 * @param {{ file: import("../../lib/lotDocuments.js").CheckedDocument }} props
 */
function CheckResult({ file }) {
  const recordedIn = file.kind === "attachment" ? "the fingerprint recorded in the verified document that lists it" : "the on-chain fingerprint";
  switch (file.status) {
    case "match":
      return (
        <p className="check check--match">
          <Icon name="check" /> <span>Matches {recordedIn}</span>
        </p>
      );
    case "mismatch":
      return (
        <p className="check check--mismatch">
          <Icon name="stop" />{" "}
          <span>
            <strong>DOES NOT MATCH</strong> {recordedIn}. {file.reason}
          </span>
        </p>
      );
    case "unavailable":
      return (
        <p className="check check--unavailable">
          <Icon name="warning" />{" "}
          <span>
            Could not be fetched, so it was not checked. {file.reason}
          </span>
        </p>
      );
    default:
      return (
        <p className="check" role="status">
          <span className="spinner" aria-hidden="true" /> <span>Checking…</span>
        </p>
      );
  }
}

/**
 * The content of a verified regulator certificate.
 * @param {{ certificate: any }} props a document that passed its schema and belongs to the lot
 */
function CertificateDetails({ certificate }) {
  return (
    <dl className="facts facts--compact">
      <div className="facts__row">
        <dt>Certificate</dt>
        <dd>{certificate.certificateNumber}</dd>
      </div>
      <div className="facts__row">
        <dt>Issued by</dt>
        <dd>{certificate.issuerName}</dd>
      </div>
      <div className="facts__row">
        <dt>Scope</dt>
        <dd>{certificate.scope}</dd>
      </div>
      <div className="facts__row">
        <dt>Statement</dt>
        <dd>{certificate.statement}</dd>
      </div>
      <div className="facts__row">
        <dt>Issued</dt>
        <dd>
          {formatDate(certificate.issuedAt)}
          {certificate.validUntil ? `, valid until ${formatDate(certificate.validUntil)}` : ""}
        </dd>
      </div>
    </dl>
  );
}

/**
 * Key field and download button of a confidential attachment.
 * @param {{ file: import("../../lib/lotDocuments.js").CheckedDocument }} props a matching, encrypted attachment
 */
function ConfidentialAttachment({ file }) {
  const [keyText, setKeyText] = useState("");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState(/** @type {{ tone: "success"|"error", text: string }|null} */ (null));

  const decryptAndSave = async (event) => {
    event.preventDefault();
    setWorking(true);
    setResult(null);
    try {
      // AES-GCM authenticates the file: decryption succeeds only with the right key and unchanged bytes.
      const original = await decryptAttachment(file.bytes, keyText);
      saveFile(original, file.attachment.name);
      setResult({ tone: "success", text: `Decrypted. "${file.attachment.name}" was saved to your downloads.` });
    } catch (error) {
      setResult({ tone: "error", text: explainError(error) });
    }
    setWorking(false);
  };

  return (
    <div className="stack-small">
      <p className="check">
        <Icon name="lock" />{" "}
        <span>
          Confidential: this file was encrypted before it was uploaded. Its integrity was verified, but only people who were
          given the key can read it.
        </span>
      </p>
      <form className="inline-form" onSubmit={decryptAndSave} noValidate>
        <Field
          id={`attachment-key-${file.id}`}
          label="Key"
          hint="43 characters, shared privately by the manufacturer. It stays in this browser."
          value={keyText}
          onChange={setKeyText}
          autoComplete="off"
          spellCheck="false"
        />
        <button type="submit" className="button button--secondary" disabled={working || keyText.trim() === ""}>
          Decrypt and download
        </button>
      </form>
      {result ? (
        <Notice tone={result.tone} live>
          <p>{result.text}</p>
        </Notice>
      ) : null}
    </div>
  );
}

/**
 * One file: what it is, the result of its check, and what can be done with it.
 * @param {{ file: import("../../lib/lotDocuments.js").CheckedDocument }} props
 */
function DocumentCard({ file }) {
  const isAttachment = file.kind === "attachment";
  const encrypted = isAttachment && file.attachment.encryption !== null;
  const gatewayUrl = gatewayUrlFor(file.ref.cid);

  return (
    <li className="document">
      <h3 className="document__title breakable">
        {isAttachment ? "Attachment: " : ""}
        {file.title}
        {file.isExcursion ? <span className="badge badge--danger">contains the reported excursion</span> : null}
      </h3>
      {isAttachment ? (
        <p className="small muted">
          {kebabToWords(file.attachment.kind)}, {formatBytes(file.attachment.size)}
          {encrypted ? ", encrypted" : ""}
        </p>
      ) : null}

      <CheckResult file={file} />
      {file.contentProblem ? (
        <p className="check check--unavailable">
          <Icon name="warning" /> <span>Its content is not used. {file.contentProblem}</span>
        </p>
      ) : null}

      {file.kind === "regulator-certificate" && file.document ? <CertificateDetails certificate={file.document} /> : null}
      {file.status === "match" && encrypted ? <ConfidentialAttachment file={file} /> : null}
      {file.status === "match" && isAttachment && !encrypted ? (
        <button type="button" className="button button--secondary button--small" onClick={() => saveFile(file.bytes, file.attachment.name)}>
          Download
        </button>
      ) : null}

      <details className="document__details">
        <summary>Technical details</summary>
        <dl className="facts facts--compact">
          <div className="facts__row">
            <dt>IPFS address (CID)</dt>
            <dd className="mono breakable">{file.ref.cid}</dd>
          </div>
          <div className="facts__row">
            <dt>Recorded fingerprint (keccak256)</dt>
            <dd className="mono breakable">{file.ref.contentHash}</dd>
          </div>
          {/* The link is built only from a CID that parsed, never from other text in a document. */}
          {gatewayUrl && !isAttachment ? (
            <div className="facts__row">
              <dt>File</dt>
              <dd>
                <a href={gatewayUrl} target="_blank" rel="noopener noreferrer">
                  Open the file on the gateway
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
      </details>
    </li>
  );
}

/**
 * @param {{ documents: import("../../lib/lotDocuments.js").CheckedDocument[] }} props every file of the lot, already checked
 */
export function Documents({ documents }) {
  return (
    <section className="card" aria-labelledby="documents-title">
      <h2 id="documents-title">Documents</h2>
      <p className="muted">
        Each file was downloaded and compared with the fingerprint that was recorded when it was added. A file that was changed
        afterwards cannot match.
      </p>
      <ul className="document-list">
        {documents.map((file) => (
          <DocumentCard key={file.id} file={file} />
        ))}
      </ul>
    </section>
  );
}
