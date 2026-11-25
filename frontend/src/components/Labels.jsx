/**
 * Small pieces of text that recur on every page: a lot's status, an account's
 * roles and an address.
 */

import { roleLabel, Status, statusLabel } from "../lib/constants.js";
import { shortAddress } from "../lib/format.js";

/** Visual group per status. The badge always shows the status in words; the colour is an extra cue. */
const STATUS_TONE = {
  [Status.Created]: "active",
  [Status.InTransit]: "active",
  [Status.Stored]: "active",
  [Status.Delivered]: "ok",
  [Status.Compromised]: "danger",
  [Status.Recalled]: "danger",
};

/**
 * @param {{ status: number }} props a value of the contract's Status enum
 */
export function StatusBadge({ status }) {
  return <span className={`badge badge--${STATUS_TONE[status] ?? "active"}`}>{statusLabel(status)}</span>;
}

/**
 * The roles an account holds, or "No role".
 * @param {{ roles: string[] }} props role keys
 */
export function RoleBadges({ roles }) {
  if (roles.length === 0) return <span className="badge">No role</span>;
  return (
    <span className="badge-row">
      {roles.map((role) => (
        <span key={role} className="badge badge--active">
          {roleLabel(role)}
        </span>
      ))}
    </span>
  );
}

/**
 * An address in short form; the full address is available as a tooltip and to screen readers.
 * @param {{ address: string }} props
 */
export function Address({ address }) {
  return (
    <span className="mono nowrap" title={address}>
      <span aria-hidden="true">{shortAddress(address)}</span>
      <span className="visually-hidden">{address}</span>
    </span>
  );
}

/**
 * An organization as "Role 0x1234…abcd". The role comes from what the account holds on-chain.
 * @param {{ address: string, roles?: string[] }} props
 */
export function Organization({ address, roles = [] }) {
  return (
    <span>
      {roleLabel(roles[0] ?? null)} <Address address={address} />
    </span>
  );
}

/**
 * A lot's product name and lot number, or what is known instead.
 * @param {{ summary: import("../hooks/useLots.js").LotSummary|undefined }} props
 */
export function ProductName({ summary }) {
  if (summary?.productName) {
    return (
      <span>
        {summary.productName} <span className="muted small">(lot number {summary.lotNumber})</span>
      </span>
    );
  }
  switch (summary?.metadataStatus) {
    case "mismatch":
      return <span className="muted">Not shown: the metadata file does not match its fingerprint</span>;
    case "unavailable":
      return <span className="muted">Name not available</span>;
    case "match":
      return <span className="muted">Not shown: the metadata file is not valid for this lot</span>;
    default:
      return <span className="muted">Loading…</span>;
  }
}
