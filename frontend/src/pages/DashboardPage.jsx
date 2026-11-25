/**
 * Organization dashboard: sign in, then see one panel per role the account
 * holds on-chain (proposal Table I).
 *
 * The page owns the data every panel needs (all lots, the organization
 * directory) and the action runner, and re-reads the chain after every action
 * and every few seconds.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

import { readFileServiceHealth } from "../chain/files.js";
import { createDirectoryReader } from "../chain/history.js";
import { readNodeAccounts } from "../chain/registry.js";
import { ActionProvider, UnplacedActionOutcome } from "../components/dashboard/ActionRunner.jsx";
import { DistributorPanel, ManufacturerPanel, OraclePanel, PharmacyPanel } from "../components/dashboard/CustodyPanels.jsx";
import { RegulatorPanel } from "../components/dashboard/RegulatorPanel.jsx";
import { SignIn } from "../components/dashboard/SignIn.jsx";
import { Layout } from "../components/Layout.jsx";
import { Notice } from "../components/Notice.jsx";
import { RegistryGate } from "../components/RegistryGate.jsx";
import { config } from "../config.js";
import { useLots } from "../hooks/useLots.js";
import { usePolling } from "../hooks/usePolling.js";
import { sameAddress } from "../lib/actions.js";
import { explainError } from "../lib/errors.js";
import { useSession } from "../state/session.jsx";

/** How often the dashboard asks the file service whether it is up, in milliseconds. */
const FILE_SERVICE_CHECK_MS = 5000;

/** No organizations are known until the directory has been read. */
const NO_ORGANIZATIONS = Object.freeze([]);

/**
 * The organization directory: the local node's test accounts and every account
 * that was ever granted a role, with the roles each holds now.
 *
 * @param {import("../lib/networks.js").Network} network
 * @param {string|null} walletAddress a connected wallet's address, so it is listed even before it has a role
 */
function useDirectory(network, walletAddress) {
  const reader = useMemo(() => createDirectoryReader(network), [network]);
  // The wallet address is read through a ref so that switching accounts in the wallet triggers one
  // extra read instead of restarting the polling, which would blank the directory for a moment.
  const wallet = useRef(walletAddress);
  const read = useCallback(async () => {
    const nodeAccounts = network.isLocal ? await readNodeAccounts(network) : [];
    return reader(nodeAccounts, wallet.current ? [wallet.current] : []);
  }, [reader, network]);
  const directory = usePolling(read, network.pollMs);

  const { refresh } = directory;
  useEffect(() => {
    if (wallet.current === walletAddress) return;
    wallet.current = walletAddress;
    refresh();
  }, [walletAddress, refresh]);
  return directory;
}

/**
 * Tells organizations that upload documents when the file service is down,
 * before they fill in a form.
 */
function FileServiceNotice() {
  const { error, loading } = usePolling(readFileServiceHealth, FILE_SERVICE_CHECK_MS);
  if (loading || !error) return null;
  return (
    <Notice tone="warning" title="The file service is not running" live>
      <p>
        Registering a lot and issuing a certificate upload a document first, and the file service at {config.uploadServiceUrl} is
        not answering. Start it in a terminal:
      </p>
      <code className="command-block">{"cd oracle && npm run service"}</code>
      <p className="small muted">This notice disappears by itself once the service answers.</p>
    </Notice>
  );
}

/**
 * The dashboard once the registry is reachable.
 * @param {{ network: import("../lib/networks.js").Network }} props
 */
function Dashboard({ network }) {
  const { account } = useSession();
  const lotState = useLots(network);
  const directory = useDirectory(network, account?.mode === "wallet" ? account.address : null);

  const refreshLots = lotState.refresh;
  const refreshDirectory = directory.refresh;
  const refreshAll = useCallback(() => Promise.all([refreshLots(), refreshDirectory()]), [refreshLots, refreshDirectory]);

  const organizations = directory.data ?? NO_ORGANIZATIONS;
  const roles = account ? (organizations.find((organization) => sameAddress(organization.address, account.address))?.roles ?? []) : [];

  /** @type {import("../components/dashboard/LotRow.jsx").DashboardData|null} */
  const data = account
    ? {
        network,
        address: account.address,
        lots: lotState.lots,
        summaries: lotState.summaries,
        rolesByAddress: lotState.rolesByAddress,
        organizations,
      }
    : null;

  const readError = directory.error ?? lotState.error;
  const uploadsDocuments = roles.includes("MANUFACTURER") || roles.includes("REGULATOR");

  return (
    <div className="stack">
      {/* Outside the keyed provider below, so the account menu keeps keyboard focus when the account changes. */}
      <SignIn network={network} organizations={organizations} roles={roles} />

      {/*
        One action provider per signed-in account. An action's result says what "this account" did, so it must not
        be shown to the next account; the key also gives every account fresh panels (no half-filled form or open
        hand-off picker left over from the previous one). The provider renders no element of its own, so its
        children are still laid out by the surrounding stack.
      */}
      <ActionProvider key={account?.address ?? "signed-out"} onSettled={refreshAll}>
        {readError ? (
          <Notice tone="error" title="The latest read from the blockchain failed" live>
            <p>{explainError(readError)}</p>
          </Notice>
        ) : null}

        {/* The result of an action whose lot row or form is no longer on screen (see ActionRunner.jsx). */}
        <UnplacedActionOutcome />

        {data && directory.loading ? (
          <p className="muted" role="status">
            Reading this account's roles…
          </p>
        ) : null}

        {data && !directory.loading && roles.length === 0 ? (
          <Notice tone="info" title="This account has no role yet">
            <p>
              Only organizations onboarded by the regulator can record anything. Give this address to the regulator and ask for
              the role of your organization:
            </p>
            <p className="mono breakable">{data.address}</p>
          </Notice>
        ) : null}

        {data && uploadsDocuments ? <FileServiceNotice /> : null}
        {data && roles.includes("REGULATOR") ? <RegulatorPanel data={data} /> : null}
        {data && roles.includes("MANUFACTURER") ? <ManufacturerPanel data={data} /> : null}
        {data && roles.includes("DISTRIBUTOR") ? <DistributorPanel data={data} /> : null}
        {data && roles.includes("RETAILER") ? <PharmacyPanel data={data} /> : null}
        {data && roles.includes("ORACLE") ? <OraclePanel /> : null}
      </ActionProvider>
    </div>
  );
}

export function DashboardPage() {
  const { network } = useSession();
  return (
    <Layout>
      <div className="stack">
        <div>
          <h1>Organization dashboard</h1>
          <p className="muted">
            Each organization sees the actions of its own role. Every action is a signed transaction on {network.name}.
          </p>
        </div>
        <RegistryGate network={network}>
          <Dashboard network={network} />
        </RegistryGate>
      </div>
    </Layout>
  );
}
