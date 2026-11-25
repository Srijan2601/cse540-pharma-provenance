/**
 * The regulator's panel (proposal Table I): grant roles, issueCertificate,
 * recallBatch.
 *
 *   Organizations   which known accounts hold which role; grant or revoke one
 *                   of the four organization roles for any address
 *   All lots        issue a certificate (a document that is uploaded first)
 *                   or recall a lot, for every lot that is not recalled yet
 */

import { getAddress, isAddress } from "ethers";
import { useState } from "react";

import { issueCertificate, sendTransaction } from "../../chain/operations.js";
import { getRegistry } from "../../chain/provider.js";
import { readRoles } from "../../chain/registry.js";
import { lotActions } from "../../lib/actions.js";
import { ORGANIZATION_ROLE_KEYS, roleLabel, ROLES } from "../../lib/constants.js";
import { UserMessageError } from "../../lib/errors.js";
import { EMPTY_CERTIFICATE_FORM, validateCertificateForm } from "../../lib/forms.js";
import { shortAddress } from "../../lib/format.js";
import { useSession } from "../../state/session.jsx";
import { Field } from "../Field.jsx";
import { Address, RoleBadges } from "../Labels.jsx";
import { Notice } from "../Notice.jsx";
import { ActionOutcome, useActions } from "./ActionRunner.jsx";
import { LotList, LotRow } from "./LotRow.jsx";

const ROLES_SCOPE = "roles";

/**
 * "Organizations": who holds which role, and the grant / revoke form.
 * @param {{ data: import("./LotRow.jsx").DashboardData }} props
 */
function Organizations({ data }) {
  const { network, organizations } = data;
  const { getSigner } = useSession();
  const { busy, run } = useActions();
  const [address, setAddress] = useState("");
  const [roleKey, setRoleKey] = useState(ORGANIZATION_ROLE_KEYS[0]);
  const [error, setError] = useState(null);

  const withRole = organizations.filter((organization) => organization.roles.length > 0);
  const withoutRole = organizations.length - withRole.length;

  /**
   * Grant or revoke the chosen role for the typed address.
   * @param {"grantRole"|"revokeRole"} method
   */
  const change = (method) => {
    const typed = address.trim();
    if (!isAddress(typed)) {
      setError("Enter a valid address: 0x followed by 40 hexadecimal characters.");
      return;
    }
    setError(null);
    const account = getAddress(typed);
    const label = roleLabel(roleKey);
    run(
      ROLES_SCOPE,
      async () => {
        // grantRole and revokeRole succeed silently when there is nothing to change, so say so instead of sending.
        const holds = (await readRoles(network, [account]))[account].includes(roleKey);
        if (method === "grantRole" && holds) throw new UserMessageError(`${shortAddress(account)} already holds the ${label} role.`);
        if (method === "revokeRole" && !holds) {
          throw new UserMessageError(`${shortAddress(account)} does not hold the ${label} role, so there is nothing to revoke.`);
        }
        await sendTransaction(getRegistry(network, await getSigner()), method, [ROLES[roleKey].id, account]);
      },
      method === "grantRole"
        ? `${label} role granted to ${shortAddress(account)}.`
        : `${label} role revoked from ${shortAddress(account)}.`,
    );
  };

  return (
    <section className="card stack-small" aria-labelledby="organizations-card-title">
      <h3 id="organizations-card-title">Organizations</h3>
      <table className="table table--stacked">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Roles</th>
          </tr>
        </thead>
        <tbody>
          {withRole.map((organization) => (
            <tr key={organization.address}>
              <td data-label="Account">
                <span>
                  <Address address={organization.address} />
                  {organization.nodeIndex !== null ? <span className="muted small"> (test account #{organization.nodeIndex})</span> : null}
                </span>
              </td>
              <td data-label="Roles">
                <RoleBadges roles={organization.roles} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {withoutRole > 0 ? (
        <p className="small muted">
          {withoutRole} other known {withoutRole === 1 ? "account holds" : "accounts hold"} no role.
        </p>
      ) : null}

      <form className="stack-small" onSubmit={(event) => event.preventDefault()} noValidate>
        <div className="form-grid">
          <Field
            id="role-address"
            label="Account address"
            hint="Paste the organization's address, or pick a known account."
            value={address}
            onChange={setAddress}
            error={error ?? undefined}
            list="known-accounts"
            autoComplete="off"
            spellCheck="false"
          />
          <Field id="role-key" as="select" label="Role" value={roleKey} onChange={setRoleKey}>
            {ORGANIZATION_ROLE_KEYS.map((key) => (
              <option key={key} value={key}>
                {roleLabel(key)}
              </option>
            ))}
          </Field>
        </div>
        {/* Suggestions for the address field; the label says what each known account holds. */}
        <datalist id="known-accounts">
          {organizations.map((organization) => (
            <option
              key={organization.address}
              value={organization.address}
              label={
                (organization.nodeIndex !== null ? `Test account #${organization.nodeIndex}: ` : "") +
                (organization.roles.map(roleLabel).join(", ") || "no role")
              }
            />
          ))}
        </datalist>
        <div className="button-row">
          <button type="button" className="button button--small" disabled={busy} onClick={() => change("grantRole")}>
            Grant role
          </button>
          <button type="button" className="button button--secondary button--small" disabled={busy} onClick={() => change("revokeRole")}>
            Revoke role
          </button>
        </div>
      </form>
      <ActionOutcome scope={ROLES_SCOPE} />
    </section>
  );
}

/**
 * The form behind "Issue certificate".
 * @param {object} props
 * @param {import("../../chain/registry.js").Lot} props.lot
 * @param {boolean} props.busy
 * @param {(form: typeof EMPTY_CERTIFICATE_FORM) => void} props.onSubmit receives a form that passed validation
 * @param {() => void} props.onClose
 */
function CertificateForm({ lot, busy, onSubmit, onClose }) {
  const [form, setForm] = useState(EMPTY_CERTIFICATE_FORM);
  const [errors, setErrors] = useState({});
  const set = (field) => (value) => setForm((previous) => ({ ...previous, [field]: value }));

  const submit = (event) => {
    event.preventDefault();
    const problems = validateCertificateForm(form);
    setErrors(problems);
    if (Object.keys(problems).length === 0) onSubmit(form);
  };

  const id = (name) => `certificate-${name}-${lot.id}`;
  return (
    <form className="lot-row__panel stack-small" onSubmit={submit} noValidate>
      <div className="form-grid">
        <Field
          id={id("number")}
          label="Certificate number"
          value={form.certificateNumber}
          onChange={set("certificateNumber")}
          error={errors.certificateNumber}
        />
        <Field id={id("issuer")} label="Issuer name" value={form.issuerName} onChange={set("issuerName")} error={errors.issuerName} />
        <Field
          id={id("scope")}
          className="form-grid__wide"
          label="Scope"
          hint="What the certificate covers, for example: Batch release"
          value={form.scope}
          onChange={set("scope")}
          error={errors.scope}
        />
        <Field
          id={id("statement")}
          as="textarea"
          className="form-grid__wide"
          label="Statement"
          hint="The certificate is public: patients read it on the verify page."
          value={form.statement}
          onChange={set("statement")}
          error={errors.statement}
        />
      </div>
      <div className="button-row">
        <button type="submit" className="button button--small" disabled={busy}>
          Issue certificate
        </button>
        <button type="button" className="button button--secondary button--small" onClick={onClose}>
          Close
        </button>
      </div>
    </form>
  );
}

/**
 * The form behind "Recall": a reason, then an explicit confirmation, because a recall is final.
 * @param {object} props
 * @param {import("../../chain/registry.js").Lot} props.lot
 * @param {boolean} props.busy
 * @param {(reason: string) => void} props.onConfirm
 * @param {() => void} props.onClose
 */
function RecallForm({ lot, busy, onConfirm, onClose }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const review = (event) => {
    event.preventDefault();
    if (reason.trim() === "") {
      setError("Enter the reason for the recall.");
      return;
    }
    setError(null);
    setConfirming(true);
  };

  if (confirming) {
    return (
      <div className="lot-row__panel stack-small">
        <Notice tone="warning" title={`Recall lot ${lot.id}? This cannot be undone.`}>
          <p>Everyone who verifies this lot will be told not to use it, and no organization can act on it any more.</p>
          <p>Reason, as it will be published: {reason.trim()}</p>
        </Notice>
        <div className="button-row">
          <button type="button" className="button button--danger button--small" disabled={busy} onClick={() => onConfirm(reason.trim())}>
            Confirm recall
          </button>
          <button type="button" className="button button--secondary button--small" onClick={() => setConfirming(false)}>
            Go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="lot-row__panel stack-small" onSubmit={review} noValidate>
      <Field
        id={`recall-reason-${lot.id}`}
        as="textarea"
        label="Reason for the recall"
        hint="The reason is published on the blockchain and shown to patients. Do not include personal data."
        value={reason}
        onChange={setReason}
        error={error ?? undefined}
      />
      <div className="button-row">
        <button type="submit" className="button button--danger button--small">
          Recall lot…
        </button>
        <button type="button" className="button button--secondary button--small" onClick={onClose}>
          Close
        </button>
      </div>
    </form>
  );
}

/**
 * A lot row with the regulator's two actions.
 * @param {{ data: import("./LotRow.jsx").DashboardData, lot: import("../../chain/registry.js").Lot }} props
 */
function RegulatorLotRow({ data, lot }) {
  const { network, address } = data;
  const { getSigner } = useSession();
  const { busy, run } = useActions();
  /** Which inline form is open: "certificate", "recall" or null. */
  const [open, setOpen] = useState(null);

  const actions = lotActions(lot, address, ["REGULATOR"]);
  const scope = `lot-${lot.id}`;
  const toggle = (form) => setOpen((current) => (current === form ? null : form));

  const certify = async (form) => {
    const { ok } = await run(
      scope,
      async (report) => issueCertificate({ network, signer: await getSigner(), lot, form, report }),
      "Certificate uploaded and recorded for this lot.",
    );
    if (ok) setOpen(null);
  };

  const recall = async (reason) => {
    const { ok } = await run(
      scope,
      async () => sendTransaction(getRegistry(network, await getSigner()), "recallBatch", [lot.id, reason]),
      "Lot recalled. Its verify page now tells people not to use it.",
    );
    if (ok) setOpen(null);
  };

  return (
    <LotRow data={data} lot={lot}>
      {actions.canCertify || actions.canRecall ? (
        <div className="button-row">
          <button type="button" className="button button--small" aria-expanded={open === "certificate"} onClick={() => toggle("certificate")}>
            {lot.certificate ? "Replace certificate" : "Issue certificate"}
          </button>
          <button
            type="button"
            className="button button--secondary button--small"
            aria-expanded={open === "recall"}
            onClick={() => toggle("recall")}
          >
            Recall
          </button>
        </div>
      ) : (
        <p className="small muted">This lot is recalled. A recall is final, so no further action is possible.</p>
      )}
      {open === "certificate" && actions.canCertify ? (
        <CertificateForm lot={lot} busy={busy} onSubmit={certify} onClose={() => setOpen(null)} />
      ) : null}
      {open === "recall" && actions.canRecall ? <RecallForm lot={lot} busy={busy} onConfirm={recall} onClose={() => setOpen(null)} /> : null}
    </LotRow>
  );
}

/** @param {{ data: import("./LotRow.jsx").DashboardData }} props */
export function RegulatorPanel({ data }) {
  return (
    <section className="stack-small" aria-labelledby="regulator-panel-title">
      <h2 id="regulator-panel-title">Regulator</h2>
      <Organizations data={data} />
      <section className="card" aria-labelledby="regulator-lots-title">
        <h3 id="regulator-lots-title">All lots</h3>
        <LotList
          lots={data.lots}
          emptyText="No lot has been registered yet."
          renderLot={(lot) => <RegulatorLotRow key={lot.id} data={data} lot={lot} />}
        />
      </section>
    </section>
  );
}
