/**
 * The optional MetaMask path ("one MetaMask wallet per org" in the proposal).
 *
 * The local demo does not need it: there the node's own test accounts sign
 * (see state/session.jsx). This module is the thin layer over the browser
 * wallet's EIP-1193 object, window.ethereum, for a deployment where each
 * organization has its own wallet.
 */

import { BrowserProvider, getAddress } from "ethers";

/**
 * @returns {boolean} true when a browser wallet such as MetaMask is installed
 */
export function isWalletAvailable() {
  return typeof window.ethereum?.request === "function";
}

/**
 * Read the wallet's chain id.
 * @returns {Promise<number>}
 */
async function readWalletChainId() {
  return Number(await window.ethereum.request({ method: "eth_chainId" }));
}

/**
 * Ask the wallet to connect. The wallet shows its own approval window.
 *
 * @returns {Promise<{ address: string, chainId: number }>} the selected account and the wallet's chain
 * @throws when the person declines (ethers' code ACTION_REJECTED or the wallet's code 4001)
 */
export async function connectWallet() {
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  return { address: getAddress(accounts[0]), chainId: await readWalletChainId() };
}

/**
 * Follow account and chain changes made inside the wallet.
 *
 * @param {(wallet: { address: string|null, chainId: number }) => void} onChange called with the new state;
 *        `address` is null when the wallet was locked or disconnected
 * @returns {() => void} call it to stop listening
 */
export function watchWallet(onChange) {
  const report = async (accounts) => {
    const list = accounts ?? (await window.ethereum.request({ method: "eth_accounts" }));
    onChange({ address: list.length > 0 ? getAddress(list[0]) : null, chainId: await readWalletChainId() });
  };
  const onAccounts = (accounts) => report(accounts);
  const onChain = () => report(null);
  window.ethereum.on("accountsChanged", onAccounts);
  window.ethereum.on("chainChanged", onChain);
  return () => {
    window.ethereum.removeListener("accountsChanged", onAccounts);
    window.ethereum.removeListener("chainChanged", onChain);
  };
}

/**
 * A signer for the wallet's selected account.
 * @returns {Promise<import("ethers").Signer>}
 */
export function getWalletSigner() {
  // A new provider for each use: an ethers BrowserProvider remembers the chain it first saw and
  // would reject requests after the person switches networks in the wallet.
  return new BrowserProvider(window.ethereum).getSigner();
}
