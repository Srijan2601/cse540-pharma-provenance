// Helpers for the single-wallet mode of scripts/demo.js.
//
// The demo has seven actors, and the registry tells them apart by address
// (msg.sender), so each actor needs an account of its own. A local Hardhat
// chain provides twenty funded test accounts. A public network provides only
// the one account whose key the team configured (DEPLOYER_PRIVATE_KEY). In
// that case the demo derives the other six accounts from that one, here, and
// pays for their transactions out of it.
//
// This module does not import Hardhat; the caller passes the signer.
import { keccak256, Signature, Wallet } from "ethers";
import { readFile } from "node:fs/promises";
import { fromRoot } from "./abi.js";
import { GAS_REPORT_JSON_PATH } from "./gas-report-stamp.js";

// The text the signer signs for one role. Changing it changes every derived
// address, and whatever an earlier run left in the old wallets stays there.
const derivationMessage = (role) => `ProvenanceRegistry demo: throwaway testnet wallet for the role "${role}"`;

/**
 * Derive one wallet per role from `signer`, with no key stored anywhere.
 *
 *   private key = keccak256(signature of `signer` over a fixed text that names the role)
 *
 * Hardhat signs with deterministic nonces (RFC 6979), so the same signer gets
 * the same signature, the same key and the same address on every run. A run
 * therefore finds the wallets of the previous run again, with whatever funds
 * they still hold, and there is no key file that could be lost or committed.
 *
 * Why this is acceptable here: the wallets only ever hold a fraction of one
 * test POL, which has no market value, for the gas of a demo run. And a
 * derived key is exactly as secret as the signer's own key, because only its
 * holder can produce the signature.
 *
 * Why it must never be used for anything of value:
 *   * A signature is not treated as a secret anywhere else. Wallet software
 *     shows it, dApps store and log it, and any web page may ask a wallet to
 *     sign a text. Whoever obtains this one signature once owns the derived
 *     wallet for good, and the key cannot be rotated without changing the text.
 *   * The scheme depends on deterministic signing. A signer that adds
 *     randomness to its signatures (multi-party wallets do, and signing
 *     libraries offer it as an option) would derive a new wallet on every run
 *     and strand the funds of the old one. The check below stops the script
 *     in that case.
 *   * It is not a reviewed standard such as BIP-32, and the keys sit unencrypted
 *     in this process's memory for the whole run.
 *
 * The keys are never printed or written to disk; only the returned Wallet
 * objects hold them.
 *
 * @param {import("ethers").Signer} signer the network's one account, connected to a provider
 * @param {string[]} roles one name per wallet, e.g. "manufacturer"
 * @returns {Promise<Wallet[]>} one wallet per role, in the order of `roles`, on the signer's provider
 */
export async function deriveDemoWallets(signer, roles) {
  const wallets = [];
  for (const role of roles) {
    const message = derivationMessage(role);
    const signature = await signer.signMessage(message);
    if ((await signer.signMessage(message)) !== signature) {
      throw new Error(
        "This network's signer does not sign deterministically, so the demo wallets cannot be derived from it: " +
          "every run would get new, empty wallets.",
      );
    }
    // Signature.from(...).serialized is the canonical 65-byte form, so the key
    // does not depend on how a signer happens to encode the same signature.
    wallets.push(new Wallet(keccak256(Signature.from(signature).serialized), signer.provider));
  }
  return wallets;
}

/**
 * Gas per contract function, from the committed gas report: for each function
 * the highest figure among its measured cases (for example, the first sensor
 * log of a lot costs more than a later one). The demo budgets with the highest
 * case because an estimate that is too low could leave a wallet unable to pay
 * for its last step.
 *
 * @returns {Promise<(functionName: string) => bigint>} lookup that throws for a function the report lacks
 */
export async function highestReportedGas() {
  const { operations } = JSON.parse(await readFile(fromRoot(GAS_REPORT_JSON_PATH), "utf8"));
  const highest = new Map();
  for (const { function: name, gas } of operations) {
    highest.set(name, Math.max(gas, highest.get(name) ?? 0));
  }
  return (functionName) => {
    const gas = highest.get(functionName);
    if (gas === undefined) {
      throw new Error(`${GAS_REPORT_JSON_PATH} has no figure for ${functionName}(). Regenerate it: npm run gas:report`);
    }
    return BigInt(gas);
  };
}
