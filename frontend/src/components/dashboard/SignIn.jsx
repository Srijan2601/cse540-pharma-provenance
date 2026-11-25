/**
 * The sign-in card of the dashboard: who is signed in, and how to sign in.
 *
 * Local test accounts are listed with the roles they hold on-chain right now
 * (read with hasRole, not from a hard-coded list), so the menu stays right
 * when the regulator grants or revokes a role. MetaMask is offered next to
 * them when the extension is installed.
 */

import { roleLabel } from "../../lib/constants.js";
import { shortAddress } from "../../lib/format.js";
import { useSession } from "../../state/session.jsx";
import { Address, RoleBadges } from "../Labels.jsx";
import { Notice } from "../Notice.jsx";

/**
 * @param {object} props
 * @param {import("../../lib/networks.js").Network} props.network
 * @param {import("../../chain/history.js").Organization[]} props.organizations known accounts with their roles
 * @param {string[]} props.roles roles of the signed-in account
 */
export function SignIn({ network, organizations, roles }) {
  const { account, walletAvailable, walletProblem, signInLocal, signInWallet, signOut } = useSession();
  const testAccounts = organizations.filter((organization) => organization.nodeIndex !== null);

  const chooseLocal = (value) => {
    if (value === "") {
      signOut();
      return;
    }
    const chosen = testAccounts.find((organization) => organization.nodeIndex === Number(value));
    if (chosen) signInLocal(chosen.nodeIndex, chosen.address);
  };

  return (
    <section className="card stack-small" aria-labelledby="sign-in-title">
      <h2 id="sign-in-title">{account ? "Signed in" : "Sign in as an organization"}</h2>

      {account ? (
        <p className="account-line">
          <Address address={account.address} />
          <RoleBadges roles={roles} />
          <span className="muted small">
            {account.mode === "local" ? `local test account #${account.nodeIndex}` : "MetaMask"} on {network.name}
          </span>
          <button type="button" className="button button--secondary button--small" onClick={signOut}>
            Sign out
          </button>
        </p>
      ) : null}

      {network.isLocal && testAccounts.length > 0 ? (
        <div className="field">
          <label className="field__label" htmlFor="local-account">
            Local test account
          </label>
          <span id="local-account-hint" className="field__hint">
            These are the local Hardhat node's own test accounts. The node signs for them, so no wallet or password is needed.
            They exist only on this local chain.
          </span>
          <select
            id="local-account"
            className="select"
            aria-describedby="local-account-hint"
            value={account?.mode === "local" ? String(account.nodeIndex) : ""}
            onChange={(event) => chooseLocal(event.target.value)}
          >
            <option value="">Choose an account…</option>
            {testAccounts.map((organization) => (
              <option key={organization.address} value={organization.nodeIndex}>
                #{organization.nodeIndex} · {organization.roles.map(roleLabel).join(", ") || "no role"} · {shortAddress(organization.address)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="button-row">
        <button type="button" className="button button--secondary button--small" onClick={signInWallet} disabled={!walletAvailable}>
          Connect MetaMask
        </button>
        <span className="small muted">
          {walletAvailable
            ? "Optional: use your organization's own wallet instead."
            : "Optional. MetaMask is not installed in this browser; the local test accounts need no wallet."}
        </span>
      </div>
      {walletProblem ? (
        <Notice tone="warning" live>
          <p>{walletProblem}</p>
        </Notice>
      ) : null}
    </section>
  );
}
