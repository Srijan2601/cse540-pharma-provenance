/**
 * The manufacturer's "Register a lot" form.
 *
 * On submit: check the typed values, then (in chain/operations.js) encrypt
 * and upload the optional attachment, build and upload the lot metadata, and
 * call registerBatch. On success the new lot's id and QR code are shown.
 *
 * If the attachment was encrypted, its key is shown here exactly once. It is
 * generated in the browser and kept only in this component's memory: it is
 * not uploaded, not stored and not put on-chain, so once this panel is closed
 * nobody can show it again.
 */

import { useState } from "react";

import { registerLot } from "../../chain/operations.js";
import { EMPTY_LOT_FORM, validateLotForm } from "../../lib/forms.js";
import { todayAsDateInput } from "../../lib/format.js";
import { useSession } from "../../state/session.jsx";
import { Field } from "../Field.jsx";
import { Notice } from "../Notice.jsx";
import { LotQrCode } from "../QrCode.jsx";
import { ActionOutcome, useActions } from "./ActionRunner.jsx";

const SCOPE = "register-lot";

/**
 * The key of an encrypted attachment, with a copy button.
 * @param {{ attachmentKey: string }} props
 */
function AttachmentKey({ attachmentKey }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(attachmentKey);
      setCopied(true);
    } catch {
      // The clipboard is unavailable on plain http from another machine; the key can still be selected by hand.
      setCopied(false);
    }
  };
  return (
    <Notice tone="warning" title="Save the key of the confidential attachment now">
      <p>
        The attachment was encrypted in this browser before it was uploaded. This key is shown only once. Share it privately
        with the people who may read the file; anyone without it can check that the file is unchanged but cannot open it.
      </p>
      <div className="secret">
        <code className="breakable">{attachmentKey}</code>
        <button type="button" className="button button--secondary button--small" onClick={copy}>
          {copied ? "Copied" : "Copy key"}
        </button>
      </div>
    </Notice>
  );
}

/**
 * @param {{ network: import("../../lib/networks.js").Network }} props
 */
export function RegisterLotForm({ network }) {
  const { getSigner } = useSession();
  const { busy, run } = useActions();
  const [form, setForm] = useState(EMPTY_LOT_FORM);
  const [file, setFile] = useState(/** @type {File|null} */ (null));
  const [encryptFile, setEncryptFile] = useState(false);
  const [errors, setErrors] = useState({});
  /** The last successful registration: { lotId, attachmentKey }. */
  const [registered, setRegistered] = useState(null);
  /** Changing the key of the file input is the only way to clear the file a person chose. */
  const [fileInputKey, setFileInputKey] = useState(0);

  const today = todayAsDateInput();
  const set = (field) => (value) => setForm((previous) => ({ ...previous, [field]: value }));

  const submit = async (event) => {
    event.preventDefault();
    const problems = validateLotForm(form, { today });
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;

    setRegistered(null);
    const { ok, result } = await run(
      SCOPE,
      async (report) => registerLot({ network, signer: await getSigner(), form, file, encryptFile, report }),
      (outcome) => `Lot ${outcome.lotId} is registered.`,
    );
    if (ok) {
      setRegistered(result);
      setForm(EMPTY_LOT_FORM);
      setFile(null);
      setEncryptFile(false);
      setFileInputKey((key) => key + 1);
    }
  };

  return (
    <section className="card stack-small" aria-labelledby="register-lot-title">
      <h3 id="register-lot-title">Register a lot</h3>
      <form className="form-grid" onSubmit={submit} noValidate>
        <Field id="lot-product-code" label="Product code" value={form.productCode} onChange={set("productCode")} error={errors.productCode} />
        <Field id="lot-number" label="Lot number" value={form.lotNumber} onChange={set("lotNumber")} error={errors.lotNumber} />
        <Field
          id="lot-product-name"
          className="form-grid__wide"
          label="Product name"
          value={form.productName}
          onChange={set("productName")}
          error={errors.productName}
        />
        <Field
          id="lot-manufacturer-name"
          label="Manufacturer name"
          value={form.manufacturerName}
          onChange={set("manufacturerName")}
          error={errors.manufacturerName}
        />
        <Field id="lot-site" label="Manufacturing site" value={form.site} onChange={set("site")} error={errors.site} />
        <Field
          id="lot-manufacture-date"
          type="date"
          max={today}
          label="Manufacture date"
          value={form.manufactureDate}
          onChange={set("manufactureDate")}
          error={errors.manufactureDate}
        />
        <Field id="lot-expiry-date" type="date" label="Expiry date" value={form.expiryDate} onChange={set("expiryDate")} error={errors.expiryDate} />
        <Field
          id="lot-min-temp"
          inputMode="decimal"
          label="Lowest allowed temperature (°C)"
          value={form.minTemp}
          onChange={set("minTemp")}
          error={errors.minTemp}
        />
        <Field
          id="lot-max-temp"
          inputMode="decimal"
          label="Highest allowed temperature (°C)"
          value={form.maxTemp}
          onChange={set("maxTemp")}
          error={errors.maxTemp}
        />

        <div className="field form-grid__wide">
          <label className="field__label" htmlFor="lot-attachment">
            Attachment (optional)
          </label>
          <span id="lot-attachment-hint" className="field__hint">
            One supporting file, for example the certificate of analysis. Do not upload personal data: files on IPFS are public
            and permanent.
          </span>
          <input
            key={fileInputKey}
            id="lot-attachment"
            type="file"
            className="input"
            aria-describedby="lot-attachment-hint"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <label className="checkbox">
            <input type="checkbox" checked={encryptFile} onChange={(event) => setEncryptFile(event.target.checked)} />
            <span>Confidential: encrypt before upload (only people you give the key to can read it)</span>
          </label>
        </div>

        <div className="form-grid__wide button-row">
          <button type="submit" className="button" disabled={busy}>
            Register lot
          </button>
        </div>
      </form>

      <ActionOutcome scope={SCOPE} />

      {registered ? (
        <div className="lot-row__panel stack-small">
          <h4>QR code of lot {registered.lotId}</h4>
          <LotQrCode network={network} lotId={registered.lotId} />
          {registered.attachmentKey ? <AttachmentKey attachmentKey={registered.attachmentKey} /> : null}
          <button type="button" className="button button--secondary button--small" onClick={() => setRegistered(null)}>
            Close
          </button>
        </div>
      ) : null}
    </section>
  );
}
