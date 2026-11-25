/**
 * The app's configuration: which chains and registries it knows and where the
 * file service is.
 *
 * Everything has a default that makes the local demo work with no setup, so no
 * .env file is needed. The optional VITE_* settings are listed in
 * frontend/README.md. Vite compiles them into the public JavaScript bundle, so
 * none of them may ever hold a secret.
 *
 * This is the only module that reads import.meta.env, the deployment records
 * and window.location. The rules themselves are pure functions in
 * lib/networks.js, where they are unit tested.
 */

import { resolveNetworks } from "./lib/networks.js";

const env = import.meta.env;

/**
 * Deployment records written by scripts/deploy.js, keyed by network name.
 * A glob is used instead of plain imports because the files may not exist:
 * localhost.json appears only after a local deploy and amoy.json only once the
 * team has deployed to the testnet. The glob does not match the abi/ folder.
 */
const recordModules = import.meta.glob("@deployments/*.json", { eager: true, import: "default" });
const records = Object.fromEntries(
  Object.entries(recordModules).map(([path, record]) => [path.split("/").pop().replace(/\.json$/, ""), record]),
);

/**
 * Host name the page was loaded from. The default addresses of the node and
 * the file service use it, so a phone that opened the page from the laptop's
 * network address talks to the laptop, not to itself.
 */
const hostname = window.location.hostname || "127.0.0.1";

const { networks, defaultChainId } = resolveNetworks({ env, records, hostname });

/**
 * @param {string|undefined} value a VITE_* setting
 * @returns {string|null} the trimmed value, or null when it is not set
 */
function setting(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const uploadServiceUrl = (setting(env.VITE_UPLOAD_SERVICE_URL) ?? `http://${hostname}:8787`).replace(/\/+$/, "");
const gatewayUrl = `${(setting(env.VITE_IPFS_GATEWAY_URL) ?? `${uploadServiceUrl}/ipfs/`).replace(/\/+$/, "")}/`;

export const config = Object.freeze({
  /** Known deployments by chain id (see lib/networks.js). */
  networks,
  /** Chain used by the home page and the dashboard. */
  defaultChainId,
  /** The deployment on the default chain. */
  defaultNetwork: networks[defaultChainId],
  /** Base address of the upload + gateway service of oracle/, without a trailing slash. */
  uploadServiceUrl,
  /** Address files are downloaded from; a CID is appended to it. Always ends with "/". */
  gatewayUrl,
  /** Address of this app that QR codes point at, without a hash. */
  verifyBaseUrl: setting(env.VITE_VERIFY_BASE_URL) ?? `${window.location.origin}${window.location.pathname}`,
});
