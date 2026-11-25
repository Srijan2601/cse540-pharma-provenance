/**
 * Entry point of the IPFS storage library.
 *
 * createStorage(config) builds the backend selected by IPFS_BACKEND. Callers
 * (the upload service, the CLI, the oracle) depend only on the three-method
 * interface { add, get, has }, so switching between the local directory, a
 * Kubo node and Pinata is purely a configuration change.
 *
 * The rest of the file re-exports the library's public names so callers
 * import from one place.
 */

import { KuboBackend } from "./backends/kubo.js";
import { LocalBackend } from "./backends/local.js";
import { PinataBackend } from "./backends/pinata.js";
import { GatewayClient } from "./gateway.js";
import { LocalStore } from "./local-store.js";

export { StorageBackend, sanitizeFileName } from "./backend.js";
export { KuboBackend } from "./backends/kubo.js";
export { LocalBackend } from "./backends/local.js";
export { PinataBackend, PINATA_UPLOAD_URL } from "./backends/pinata.js";
export {
  CODEC_DAG_PB,
  CODEC_RAW,
  HASH_SHA2_256,
  IPFS_SINGLE_CHUNK_BYTES,
  MAX_CID_LENGTH,
  MAX_RAW_BLOCK_BYTES,
  cidMatchesBytes,
  computeContentHash,
  computeRawCid,
  isCid,
  parseCid,
  sha256Digest,
  toBytes,
  verifyContent,
} from "./cid.js";
export { GatewayClient } from "./gateway.js";
export { LocalStore } from "./local-store.js";

/**
 * Build the storage backend described by a configuration.
 *
 * Every backend shares the local directory (config.ipfs.localDir) and, when
 * one is configured, the read-only gateway (config.ipfs.gatewayUrl).
 *
 * @param {import("../config.js").OracleConfig} config from loadConfig()
 * @param {{ fetch?: typeof fetch }} [options] `fetch` replaces the global fetch for every outgoing request (used by tests)
 * @returns {import("./backend.js").StorageBackend} an object with add(bytes, { name }), get(cid) and has(cid)
 */
export function createStorage(config, { fetch = globalThis.fetch } = {}) {
  const { backend, localDir, kuboApiUrl, pinataJwt, gatewayUrl } = config.ipfs;
  const store = new LocalStore({ dir: localDir });
  const gateway = gatewayUrl === null ? null : new GatewayClient({ baseUrl: gatewayUrl, fetch });

  switch (backend) {
    case "local":
      return new LocalBackend({ store, gateway });
    case "kubo":
      return new KuboBackend({ apiUrl: kuboApiUrl, store, gateway, fetch });
    case "pinata":
      // The only place the JWT is revealed: it goes straight into the backend's private field.
      return new PinataBackend({ jwt: pinataJwt.reveal(), store, gateway, fetch });
    default:
      throw new TypeError(`Unknown storage backend "${backend}".`);
  }
}
