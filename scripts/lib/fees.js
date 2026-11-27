// Explicit EIP-1559 fees for transactions sent to a public network.
//
// Used by scripts/deploy.js and by the single-wallet mode of scripts/demo.js.
//
// Why the scripts do not leave the fees to the libraries: Polygon, Amoy
// included, only takes a transaction that pays at least the network's minimum
// price, about 25 gwei per gas. Amoy's base fee varies a lot: it was 63 wei at
// block 53780000 (2026-11-25) and 30 gwei from block 53800000 through the run
// of 2026-11-26 (docs/amoy-deployment.md). A large part of the price is
// therefore the priority fee, and the libraries' defaults for it do not fit:
//   * ethers falls back to a priority fee of 1 gwei when it cannot ask the
//     node, far below the minimum;
//   * Hardhat copies the median priority fee paid in the latest block, which on
//     a quiet testnet is whatever the one or two transactions in that block
//     happened to pay. In 1,024 Amoy blocks looked at on 2026-11-25 that median
//     ranged from 25 to 575 gwei. At the high end, deploying the registry would
//     cost more than one POL.
// The node itself knows what it accepts, so both values are read from it:
//   * the base fee from the latest block header;
//   * the priority fee from eth_maxPriorityFeePerGas. If the node does not
//     offer that method the scripts stop with the node's error. Guessing a
//     value would bring the problem back.
//
// This module does not import Hardhat; the caller passes the ethers provider
// of its network connection.

/**
 * The fees a transaction should carry if it is sent now.
 *
 * maxFeePerGas is twice the current base fee plus the priority fee. The base
 * fee rises by at most 12.5 % per block, so this cap still covers it after
 * five full blocks in a row. It is only a cap: a transaction pays the base fee
 * of the block that includes it plus the priority fee, never the unused rest.
 *
 * @param {import("ethers").Provider & { send(method: string, params: unknown[]): Promise<any> }} provider
 * @returns {Promise<{ baseFeePerGas: bigint, maxPriorityFeePerGas: bigint, maxFeePerGas: bigint }>} in wei
 */
export async function currentFees(provider) {
  const [block, priorityFee] = await Promise.all([
    provider.getBlock("latest"),
    provider.send("eth_maxPriorityFeePerGas", []),
  ]);
  if (block.baseFeePerGas === null) {
    throw new Error("The latest block has no base fee: this chain does not take EIP-1559 transactions.");
  }
  const maxPriorityFeePerGas = BigInt(priorityFee);
  return {
    baseFeePerGas: block.baseFeePerGas,
    maxPriorityFeePerGas,
    maxFeePerGas: 2n * block.baseFeePerGas + maxPriorityFeePerGas,
  };
}

/**
 * The two fee fields of a transaction sent now, in the form ethers takes as
 * transaction overrides.
 *
 * @param {Parameters<typeof currentFees>[0]} provider
 * @returns {Promise<{ maxFeePerGas: bigint, maxPriorityFeePerGas: bigint }>} in wei
 */
export async function feeOverrides(provider) {
  const { maxFeePerGas, maxPriorityFeePerGas } = await currentFees(provider);
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * Make every transaction that `signer` sends carry the given fees, including
 * contract calls made through `contract.connect(signer)`.
 *
 * The fees are fixed, not read again per transaction, so that a caller who
 * funded the account for its transactions at these fees knows that the
 * account can pay for every one of them.
 *
 * The method is replaced on this one signer object. The scripts use two kinds
 * of signer, Hardhat's and ethers' Wallet, which share no base class to
 * derive from, and the object keeps its identity and its `address` this way.
 *
 * Only sending is affected. Simulations (eth_call, gas estimation) of a call
 * that is not sent stay free of fee fields, so an account with no balance can
 * still be used to simulate.
 *
 * @template {import("ethers").Signer} T
 * @param {T} signer a signer connected to a provider
 * @param {{ maxFeePerGas: bigint, maxPriorityFeePerGas: bigint }} fees in wei, e.g. from currentFees()
 * @returns {T} the same signer
 */
export function sendWithFees(signer, { maxFeePerGas, maxPriorityFeePerGas }) {
  const sendTransaction = signer.sendTransaction.bind(signer);
  signer.sendTransaction = (transaction) => sendTransaction({ ...transaction, maxFeePerGas, maxPriorityFeePerGas });
  return signer;
}
