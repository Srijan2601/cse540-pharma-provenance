/**
 * Who is signed in, and on which chain the app is working.
 *
 * An organization signs in in one of two ways:
 *
 *   local test account   The default for the demo. A local Hardhat node holds
 *                        the keys of its funded test accounts and signs for
 *                        them on request, so no wallet extension, password or
 *                        private key is involved. Offered only on the local
 *                        chain (chain id 31337); such accounts do not exist
 *                        anywhere else.
 *   MetaMask             Optional. The wallet signs, and the wallet's chain
 *                        decides which known deployment the dashboard uses.
 *
 * The patient verify page never uses this: it only reads.
 *
 * The session lives in memory only. Reloading the page signs out, which is
 * what a shared demo laptop wants.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { getProvider } from "../chain/provider.js";
import { connectWallet, getWalletSigner, isWalletAvailable, watchWallet } from "../chain/wallet.js";
import { config } from "../config.js";
import { explainError } from "../lib/errors.js";

/**
 * @typedef {object} Session
 * @property {import("../lib/networks.js").Network} network  the deployment the home page and dashboard work on
 * @property {{ address: string, mode: "local"|"wallet", nodeIndex: number|null }|null} account the signed-in account
 * @property {string|null} walletProblem                     why a connected wallet cannot be used, in words
 * @property {boolean} walletAvailable                       whether a browser wallet is installed
 * @property {(nodeIndex: number, address: string) => void} signInLocal
 * @property {() => Promise<void>} signInWallet
 * @property {() => void} signOut
 * @property {() => Promise<import("ethers").Signer>} getSigner signer of the signed-in account
 */

const SessionContext = createContext(/** @type {Session|null} */ (null));

/**
 * Provides the session to the pages below it.
 * @param {{ children: import("react").ReactNode }} props
 */
export function SessionProvider({ children }) {
  /** Selected local test account: its position on the node and its address. */
  const [localAccount, setLocalAccount] = useState(null);
  /** Connected wallet: its selected address and chain; null when not connected. */
  const [wallet, setWallet] = useState(null);
  const [walletError, setWalletError] = useState(null);

  // While a wallet is connected, follow what the person does inside it.
  const walletConnected = wallet !== null;
  useEffect(() => {
    if (!walletConnected) return undefined;
    return watchWallet((next) => setWallet(next.address === null ? null : next));
  }, [walletConnected]);

  const signInLocal = useCallback((nodeIndex, address) => {
    setWallet(null);
    setWalletError(null);
    setLocalAccount({ nodeIndex, address });
  }, []);

  const signInWallet = useCallback(async () => {
    setWalletError(null);
    try {
      const connected = await connectWallet();
      setLocalAccount(null);
      setWallet(connected);
    } catch (error) {
      setWalletError(explainError(error));
    }
  }, []);

  const signOut = useCallback(() => {
    setLocalAccount(null);
    setWallet(null);
    setWalletError(null);
  }, []);

  const session = useMemo(() => {
    // A wallet on a chain with a known deployment switches the app to that deployment.
    const walletNetwork = wallet ? (config.networks[wallet.chainId] ?? null) : null;
    const network = walletNetwork ?? config.defaultNetwork;

    let account = null;
    let walletProblem = walletError;
    if (wallet && walletNetwork) {
      account = { address: wallet.address, mode: "wallet", nodeIndex: null };
    } else if (wallet) {
      const known = Object.values(config.networks)
        .map((candidate) => `${candidate.name} (chain id ${candidate.chainId})`)
        .join(" or ");
      walletProblem = `Your wallet is on chain ${wallet.chainId}, where this app has no registry deployment. Switch the wallet to ${known}.`;
    } else if (localAccount && network.isLocal) {
      account = { address: localAccount.address, mode: "local", nodeIndex: localAccount.nodeIndex };
    }

    /** @type {Session} */
    const value = {
      network,
      account,
      walletProblem,
      walletAvailable: isWalletAvailable(),
      signInLocal,
      signInWallet,
      signOut,
      getSigner: () => {
        if (account?.mode === "wallet") return getWalletSigner();
        if (account?.mode === "local") return getProvider(network).getSigner(account.address);
        return Promise.reject(new Error("No account is signed in."));
      },
    };
    return value;
  }, [wallet, walletError, localAccount, signInLocal, signInWallet, signOut]);

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/**
 * The current session.
 * @returns {Session}
 */
export function useSession() {
  const session = useContext(SessionContext);
  if (session === null) throw new Error("useSession must be used inside <SessionProvider>.");
  return session;
}
