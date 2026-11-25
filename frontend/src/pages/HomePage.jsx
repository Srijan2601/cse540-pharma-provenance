/**
 * Home page: what this is, a box to verify a lot by its id, the list of all
 * lots, and the way to the organization dashboard.
 */

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Organization, ProductName, StatusBadge } from "../components/Labels.jsx";
import { Layout } from "../components/Layout.jsx";
import { Notice } from "../components/Notice.jsx";
import { RegistryGate } from "../components/RegistryGate.jsx";
import { config } from "../config.js";
import { useLots } from "../hooks/useLots.js";
import { explainError } from "../lib/errors.js";
import { buildVerifyRoute } from "../lib/verifyLink.js";
import { useSession } from "../state/session.jsx";

/**
 * "Verify a lot": type a lot id, go to its verify page.
 * @param {{ network: import("../lib/networks.js").Network }} props
 */
function VerifyBox({ network }) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [error, setError] = useState(null);

  const submit = (event) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!/^[1-9]\d{0,14}$/.test(trimmed)) {
      setError("Enter the lot's ID as a whole number, for example 1.");
      return;
    }
    navigate(buildVerifyRoute({ lotId: Number(trimmed), chainId: network.chainId, registry: network.registry }));
  };

  return (
    <section className="card" aria-labelledby="verify-box-title">
      <h2 id="verify-box-title">Verify a lot</h2>
      <p>Enter the lot ID printed next to the QR code to see the lot's status and history.</p>
      <form className="inline-form" onSubmit={submit} noValidate>
        <div className="field">
          <label className="field__label" htmlFor="verify-lot-id">
            Lot ID
          </label>
          <input
            id="verify-lot-id"
            className="input"
            inputMode="numeric"
            autoComplete="off"
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? "verify-lot-id-error" : undefined}
          />
          {error ? (
            <span id="verify-lot-id-error" className="field__error" role="alert">
              {error}
            </span>
          ) : null}
        </div>
        <button type="submit" className="button">
          Verify
        </button>
      </form>
    </section>
  );
}

/**
 * The table of all lots, each linking to its verify page.
 * @param {{ network: import("../lib/networks.js").Network }} props
 */
function LotTable({ network }) {
  const { lots, summaries, rolesByAddress, loading, error } = useLots(network);

  if (loading) {
    return (
      <p className="muted" role="status">
        Reading the lots from the registry…
      </p>
    );
  }
  if (error && lots.length === 0) return <Notice tone="error">{explainError(error)}</Notice>;
  if (lots.length === 0) {
    return <p className="empty">No lot has been registered yet. A manufacturer registers the first one in the organization dashboard.</p>;
  }

  const filesMissing = lots.some((lot) => summaries[lot.id]?.metadataStatus === "unavailable");
  return (
    <div className="stack-small">
      {filesMissing ? (
        <Notice tone="warning" title="Product names are not available">
          <p>
            The file service at {config.gatewayUrl} is not answering, so the lot metadata could not be fetched. For the local demo,
            start it with <code>npm run service</code> in the <code>oracle/</code> folder.
          </p>
        </Notice>
      ) : null}
      <table className="table table--stacked">
        <thead>
          <tr>
            <th scope="col">Lot</th>
            <th scope="col">Product</th>
            <th scope="col">Status</th>
            <th scope="col">Current holder</th>
          </tr>
        </thead>
        <tbody>
          {lots.map((lot) => {
            const summary = summaries[lot.id];
            return (
              <tr key={lot.id}>
                <td data-label="Lot" className="nowrap">
                  <Link to={buildVerifyRoute({ lotId: lot.id, chainId: network.chainId, registry: network.registry })}>Lot {lot.id}</Link>
                </td>
                <td data-label="Product">
                  <ProductName summary={summary} />
                </td>
                <td data-label="Status">
                  <StatusBadge status={lot.status} />
                </td>
                <td data-label="Current holder">
                  <Organization address={lot.custodian} roles={rolesByAddress[lot.custodian]} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function HomePage() {
  const { network } = useSession();
  return (
    <Layout>
      <div className="stack">
        <section>
          <h1>Is this medicine what it claims to be?</h1>
          <p>
            Every lot of a temperature-sensitive medicine has one shared, tamper-evident record on a blockchain: who made it, who
            held it, whether it stayed cold, and whether the regulator certified or recalled it. Anyone can check that record
            here, without an account or a wallet.
          </p>
        </section>

        <div className="grid-two">
          <VerifyBox network={network} />
          <section className="card" aria-labelledby="organizations-title">
            <h2 id="organizations-title">For organizations</h2>
            <p>Manufacturers, distributors, pharmacies and the regulator record their part of a lot's journey in the dashboard.</p>
            <Link to="/dashboard" className="button button--secondary">
              Open the organization dashboard
            </Link>
          </section>
        </div>

        <section className="card stack-small" aria-labelledby="all-lots-title">
          <h2 id="all-lots-title">All lots</h2>
          <RegistryGate network={network}>
            <LotTable network={network} />
          </RegistryGate>
        </section>
      </div>
    </Layout>
  );
}
