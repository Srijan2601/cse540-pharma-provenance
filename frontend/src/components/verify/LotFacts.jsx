/**
 * The facts about a lot, each from the most trustworthy source available.
 *
 * Values the contract stores (manufacturer address, manufacture date, allowed
 * temperature range, current holder) are shown from the chain. Names for
 * people (product, manufacturer, site, expiry date) exist only in the lot
 * metadata file and are shown only when that file matched its fingerprint and
 * is valid metadata for this lot; otherwise the row says why it is empty.
 *
 * Everything from the file is rendered as text. React escapes it, so a
 * hostile product name cannot inject markup.
 */

import { formatDate, formatDateTime, formatTemperatureRange } from "../../lib/format.js";
import { Address, Organization, StatusBadge } from "../Labels.jsx";

/**
 * One row of the facts list.
 * @param {{ label: string, children: import("react").ReactNode }} props
 */
function Fact({ label, children }) {
  return (
    <div className="facts__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Why the metadata's fields cannot be shown.
 * @param {import("../../lib/lotDocuments.js").CheckedDocument} metadata
 * @returns {string}
 */
function metadataGap(metadata) {
  switch (metadata.status) {
    case "pending":
      return "Loading…";
    case "mismatch":
      return "Not shown: the lot metadata file does not match its fingerprint.";
    case "unavailable":
      return "Not available: the lot metadata file could not be fetched.";
    default:
      return `Not shown. ${metadata.contentProblem ?? ""}`;
  }
}

/**
 * @param {object} props
 * @param {import("../../chain/registry.js").Lot} props.lot
 * @param {import("../../lib/lotDocuments.js").CheckedDocument} props.metadata the interpreted lot metadata file
 * @param {Record<string, string[]>} props.rolesByAddress
 */
export function LotFacts({ lot, metadata, rolesByAddress }) {
  const details = metadata.document;
  const gap = details ? null : <span className="muted">{metadataGap(metadata)}</span>;

  return (
    <section className="card" aria-labelledby="facts-title">
      <div className="card__header">
        <h2 id="facts-title">About this lot</h2>
        <StatusBadge status={lot.status} />
      </div>
      <dl className="facts">
        <Fact label="Product">{details ? details.productName : gap}</Fact>
        <Fact label="Product code">{details ? details.productCode : gap}</Fact>
        <Fact label="Lot number">{details ? details.lotNumber : gap}</Fact>
        {details ? (
          <Fact label="Identity check">
            The product code and lot number match the product hash recorded on the blockchain.
          </Fact>
        ) : null}
        <Fact label="Manufacturer">
          {details ? `${details.manufacturerName}, ${details.site}, ` : null}
          <span className="muted">
            account <Address address={lot.manufacturer} />
          </span>
        </Fact>
        <Fact label="Manufactured">{formatDate(lot.manufactureDate)}</Fact>
        <Fact label="Expires">{details ? formatDate(details.expiryDate) : gap}</Fact>
        <Fact label="Allowed temperature">{formatTemperatureRange(lot.minTempTenthsC, lot.maxTempTenthsC)}</Fact>
        <Fact label="Current holder">
          <Organization address={lot.custodian} roles={rolesByAddress[lot.custodian]} />
          {lot.pendingCustodian ? (
            <span className="muted">
              {" "}
              (hand-off open to <Organization address={lot.pendingCustodian} roles={rolesByAddress[lot.pendingCustodian]} />)
            </span>
          ) : null}
        </Fact>
        <Fact label="Registered">{formatDateTime(lot.registeredAt)}</Fact>
      </dl>
    </section>
  );
}
