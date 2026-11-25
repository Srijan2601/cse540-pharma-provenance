/**
 * Shows its content only when the registry can actually be read, and
 * otherwise explains what to start.
 *
 * Every page that needs the chain is wrapped in this gate, so there is one
 * place, and one wording, for "the chain is not running", "nothing is deployed
 * yet" and "the contract is gone because the local chain was restarted". The
 * check repeats every few seconds, so the page comes to life by itself once
 * the commands have been run.
 *
 * Until the registry has answered once, a failed check replaces the content
 * with the instructions. Once it has answered, a node that stops answering
 * (often just one dropped request) only puts a short notice above the content,
 * which stays mounted: its state is worth keeping, such as the one-time key of
 * a confidential attachment, a key typed on the verify page, or the history
 * read so far. The pages keep showing their last data and say when a refresh
 * failed. A node that answers with the wrong chain or without the contract
 * still replaces the content, because what it holds belongs to another chain.
 */

import { useCallback, useState } from "react";

import { checkRegistry } from "../chain/registry.js";
import { usePolling } from "../hooks/usePolling.js";
import { CommandSteps } from "./CommandSteps.jsx";
import { Notice } from "./Notice.jsx";

/** How often the gate looks again, in milliseconds. */
const CHECK_INTERVAL_MS = 3000;

/** What has to run for the local demo, in the order to start it (the same steps as in frontend/README.md). */
const LOCAL_START_STEPS = [
  { text: "Start the local chain (port 8545) and keep it running:", command: "npm run node" },
  { text: "In a second terminal, deploy the registry:", command: "npm run deploy:local" },
  { text: "Give the demo accounts their roles:", command: "npm run roles:local" },
  { text: "In a third terminal, start the file service (port 8787) and keep it running:", command: "cd oracle && npm run service" },
];

/**
 * One sentence saying what is wrong.
 * @param {import("../lib/networks.js").Network} network
 * @param {import("../chain/registry.js").RegistryCheck} check a failed check
 * @returns {string}
 */
function describeProblem(network, check) {
  switch (check.problem) {
    case "not-configured":
      return "No registry contract has been deployed for the local chain yet: there is no deployments/localhost.json.";
    case "unreachable":
      return `The blockchain node at ${network.rpcUrl} is not answering.`;
    case "wrong-chain":
      return `The node at ${network.rpcUrl} is on chain ${check.chainId}, but this app expects chain ${network.chainId} (${network.name}).`;
    default:
      return (
        `The node at ${network.rpcUrl} is running, but there is no contract at ${network.registry}. ` +
        (network.isLocal ? "A local chain starts empty after every restart, so the registry has to be deployed again." : "")
      );
  }
}

/**
 * @param {object} props
 * @param {import("../lib/networks.js").Network} props.network the deployment the content needs
 * @param {import("react").ReactNode} props.children           rendered once the registry is readable (see the header)
 */
export function RegistryGate({ network, children }) {
  // A gate per deployment: when the page switches to another chain or registry, the check, the
  // "has answered" flag and the content all start over instead of carrying over to the new one.
  return (
    <DeploymentGate key={`${network.chainId}:${network.registry}`} network={network}>
      {children}
    </DeploymentGate>
  );
}

/**
 * The gate for one deployment.
 * @param {{ network: import("../lib/networks.js").Network, children: import("react").ReactNode }} props
 */
function DeploymentGate({ network, children }) {
  const check = useCallback(() => checkRegistry(network), [network]);
  const { data, loading } = usePolling(check, CHECK_INTERVAL_MS);
  // Whether this registry has answered at least once. Updated while rendering, which React allows for
  // state that only follows from the data being rendered; it never goes back to false.
  const [confirmed, setConfirmed] = useState(false);
  if (data?.ok && !confirmed) setConfirmed(true);

  if (loading || data === undefined) {
    return (
      <p className="muted" role="status">
        Connecting to the blockchain…
      </p>
    );
  }
  const connectionLost = !data.ok && confirmed && data.problem === "unreachable";
  if (data.ok || connectionLost) {
    // The same shape in both cases, with the notice slot first, so React keeps the content mounted
    // when the notice comes and goes; returning `children` alone in one case would remount it.
    return (
      <>
        {connectionLost ? (
          <Notice tone="warning" title="The connection to the blockchain was lost" live>
            <p>
              {describeProblem(network, data)} What is shown below was read before that. This page checks again every few
              seconds and carries on by itself.
            </p>
          </Notice>
        ) : null}
        {children}
      </>
    );
  }

  return (
    <Notice tone="warning" title="The registry is not available" live>
      <p>{describeProblem(network, data)}</p>
      {network.isLocal ? (
        <>
          <p>To start the local demo, open a terminal in the repository folder:</p>
          <CommandSteps steps={LOCAL_START_STEPS} />
        </>
      ) : (
        <p>Check the network connection and the RPC endpoint configured for {network.name}.</p>
      )}
      <p className="small muted">
        {data.problem === "not-configured"
          ? // The deployment record is compiled into the app, so only the development server can notice a new one.
            "The development server reloads this page by itself once the registry is deployed. A built app reads the deployment when it is built, so build it again."
          : "This page checks again every few seconds and continues by itself."}
      </p>
    </Notice>
  );
}
