/**
 * One lot in a dashboard list, with the custody actions of one role.
 *
 * LotRow is the frame (title, status, holder, link to the verify page, result
 * of the latest action). CustodyLotRow fills it with the buttons of a
 * manufacturer, a distributor or a pharmacy. Which buttons appear is decided
 * by lib/actions.js from the lot's state, so a button is only offered when
 * the contract would accept the call.
 */

import { getAddress, isAddress } from "ethers";
import { useState } from "react";
import { Link } from "react-router-dom";

import { sendTransaction } from "../../chain/operations.js";
import { getRegistry } from "../../chain/provider.js";
import { eligibleRecipients, lotActions } from "../../lib/actions.js";
import { roleLabel, statusLabel } from "../../lib/constants.js";
import { shortAddress } from "../../lib/format.js";
import { buildVerifyRoute } from "../../lib/verifyLink.js";
import { useSession } from "../../state/session.jsx";
import { Field } from "../Field.jsx";
import { Organization, ProductName, StatusBadge } from "../Labels.jsx";
import { LotQrCode } from "../QrCode.jsx";
import { ActionOutcome, useActions } from "./ActionRunner.jsx";

/** Value of the recipient menu's last entry, which reveals the address field. */
const OTHER_RECIPIENT = "other";

/**
 * @typedef {object} DashboardData what every panel receives
 * @property {import("../../lib/networks.js").Network} network
 * @property {string} address                       the signed-in account
 * @property {import("../../chain/registry.js").Lot[]} lots every lot in the registry
 * @property {Record<number, import("../../hooks/useLots.js").LotSummary>} summaries
 * @property {Record<string, string[]>} rolesByAddress roles of current and pending holders
 * @property {import("../../chain/history.js").Organization[]} organizations known accounts with their roles
 */

/**
 * @param {object} props
 * @param {DashboardData} props.data
 * @param {import("../../chain/registry.js").Lot} props.lot
 * @param {import("react").ReactNode} [props.children] buttons and inline forms
 */
export function LotRow({ data, lot, children }) {
  const { network, summaries, rolesByAddress } = data;
  return (
    <li className="lot-row">
      <div className="lot-row__head">
        <h4 className="lot-row__title">
          Lot {lot.id}: <ProductName summary={summaries[lot.id]} />
        </h4>
        <StatusBadge status={lot.status} />
      </div>
      <p className="lot-row__meta">
        Held by <Organization address={lot.custodian} roles={rolesByAddress[lot.custodian]} />
        {lot.pendingCustodian ? (
          <>
            {" · "}hand-off open to <Organization address={lot.pendingCustodian} roles={rolesByAddress[lot.pendingCustodian]} />
          </>
        ) : null}
        {" · "}
        <Link to={buildVerifyRoute({ lotId: lot.id, chainId: network.chainId, registry: network.registry })}>Verify page</Link>
      </p>
      {children}
      <ActionOutcome scope={`lot-${lot.id}`} />
    </li>
  );
}

/**
 * A list of lot rows, or a sentence when there are none.
 * @param {object} props
 * @param {import("../../chain/registry.js").Lot[]} props.lots
 * @param {string} props.emptyText
 * @param {(lot: import("../../chain/registry.js").Lot) => import("react").ReactNode} props.renderLot
 */
export function LotList({ lots, emptyText, renderLot }) {
  if (lots.length === 0) return <p className="empty">{emptyText}</p>;
  return <ul className="lot-list">{lots.map((lot) => renderLot(lot))}</ul>;
}

/**
 * The form that names the recipient of a hand-off: pick a known organization
 * that may receive the lot, or paste any address.
 *
 * @param {object} props
 * @param {number} props.lotId
 * @param {import("../../chain/history.js").Organization[]} props.recipients organizations the contract's routes allow
 * @param {boolean} props.busy
 * @param {(to: string) => void} props.onSubmit   receives a checksummed address
 * @param {() => void} props.onClose
 */
function HandOffForm({ lotId, recipients, busy, onSubmit, onClose }) {
  const [choice, setChoice] = useState(recipients[0]?.address ?? OTHER_RECIPIENT);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState(null);

  const submit = (event) => {
    event.preventDefault();
    const to = choice === OTHER_RECIPIENT ? typed.trim() : choice;
    if (!isAddress(to)) {
      setError("Enter a valid address: 0x followed by 40 hexadecimal characters.");
      return;
    }
    setError(null);
    onSubmit(getAddress(to));
  };

  return (
    <form className="lot-row__panel stack-small" onSubmit={submit} noValidate>
      <Field
        id={`hand-off-recipient-${lotId}`}
        as="select"
        label="Hand the lot to"
        hint="Custody moves only when the recipient accepts. Until then you can cancel."
        value={choice}
        onChange={setChoice}
      >
        {recipients.map((recipient) => (
          <option key={recipient.address} value={recipient.address}>
            {recipient.roles.map(roleLabel).join(", ")} · {shortAddress(recipient.address)}
            {recipient.nodeIndex !== null ? ` (test account #${recipient.nodeIndex})` : ""}
          </option>
        ))}
        <option value={OTHER_RECIPIENT}>Another address…</option>
      </Field>
      {choice === OTHER_RECIPIENT ? (
        <Field
          id={`hand-off-address-${lotId}`}
          label="Recipient address"
          value={typed}
          onChange={setTyped}
          error={error ?? undefined}
          autoComplete="off"
          spellCheck="false"
        />
      ) : null}
      <div className="button-row">
        <button type="submit" className="button button--small" disabled={busy}>
          Start hand-off
        </button>
        <button type="button" className="button button--secondary button--small" onClick={onClose}>
          Close
        </button>
      </div>
    </form>
  );
}

/**
 * A lot row with the custody actions of one role.
 *
 * @param {object} props
 * @param {DashboardData} props.data
 * @param {import("../../chain/registry.js").Lot} props.lot
 * @param {"MANUFACTURER"|"DISTRIBUTOR"|"RETAILER"} props.role the panel's role; only its actions are offered,
 *        even when the account holds further roles (those have their own panels)
 * @param {boolean} [props.offerQr]  add a "Show QR code" button (the manufacturer prints the code)
 */
export function CustodyLotRow({ data, lot, role, offerQr = false }) {
  const { network, address, organizations } = data;
  const { getSigner } = useSession();
  const { busy, run } = useActions();
  const [handOffOpen, setHandOffOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  const actions = lotActions(lot, address, [role]);
  const scope = `lot-${lot.id}`;

  /**
   * Send one registry transaction for this lot.
   * @param {string} method
   * @param {unknown[]} args
   * @param {string} successText
   */
  const send = (method, args, successText) =>
    run(scope, async () => sendTransaction(getRegistry(network, await getSigner()), method, args), successText);

  const startHandOff = async (to) => {
    const { ok } = await send(
      "initiateTransfer",
      [lot.id, to],
      `Hand-off to ${shortAddress(to)} started. The lot is in transit until the recipient accepts.`,
    );
    if (ok) setHandOffOpen(false);
  };

  return (
    <LotRow data={data} lot={lot}>
      <div className="button-row">
        {actions.canAccept ? (
          <button
            type="button"
            className="button button--small"
            disabled={busy}
            onClick={() => send("acceptTransfer", [lot.id], "Hand-off accepted. This account now holds the lot.")}
          >
            Accept hand-off
          </button>
        ) : null}
        {actions.nextStatus !== null ? (
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={busy}
            onClick={() =>
              send("updateStatus", [lot.id, actions.nextStatus], `Status updated to ${statusLabel(actions.nextStatus).toLowerCase()}.`)
            }
          >
            Mark as {statusLabel(actions.nextStatus).toLowerCase()}
          </button>
        ) : null}
        {actions.canStartHandOff ? (
          <button
            type="button"
            className="button button--small"
            aria-expanded={handOffOpen}
            onClick={() => setHandOffOpen((open) => !open)}
          >
            Start hand-off
          </button>
        ) : null}
        {actions.canCancelHandOff ? (
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={busy}
            onClick={() => send("cancelTransfer", [lot.id], "Hand-off cancelled. The lot is back with this account.")}
          >
            Cancel hand-off
          </button>
        ) : null}
        {actions.canMarkDelivered ? (
          <button
            type="button"
            className="button button--small"
            disabled={busy}
            onClick={() => send("markDelivered", [lot.id], "Lot marked as delivered.")}
          >
            Mark delivered
          </button>
        ) : null}
        {role === "RETAILER" ? (
          <Link
            className="button button--secondary button--small"
            to={buildVerifyRoute({ lotId: lot.id, chainId: network.chainId, registry: network.registry })}
          >
            Verify
          </Link>
        ) : null}
        {offerQr ? (
          <button
            type="button"
            className="button button--secondary button--small"
            aria-expanded={qrOpen}
            onClick={() => setQrOpen((open) => !open)}
          >
            {qrOpen ? "Hide QR code" : "Show QR code"}
          </button>
        ) : null}
      </div>

      {handOffOpen && actions.canStartHandOff ? (
        <HandOffForm
          lotId={lot.id}
          recipients={eligibleRecipients(organizations, address, [role])}
          busy={busy}
          onSubmit={startHandOff}
          onClose={() => setHandOffOpen(false)}
        />
      ) : null}
      {qrOpen ? (
        <div className="lot-row__panel">
          <LotQrCode network={network} lotId={lot.id} />
        </div>
      ) : null}
    </LotRow>
  );
}
