/**
 * Splitting a span of blocks into pages for eth_getLogs.
 *
 * A local node answers an event query over any number of blocks, but public
 * RPC endpoints reject a query whose range is too wide (the limit differs by
 * provider, often a few thousand blocks). Reading history in pages of a fixed
 * size works on both; the size is set per network in lib/networks.js.
 */

/**
 * @param {number} fromBlock  first block to read, inclusive
 * @param {number} toBlock    last block to read, inclusive
 * @param {number} chunkSize  largest number of blocks one query may span; at least 1
 * @returns {{ fromBlock: number, toBlock: number }[]} consecutive ranges that cover the span exactly
 *          once, in ascending order; empty when `fromBlock` is after `toBlock`
 */
export function splitBlockRange(fromBlock, toBlock, chunkSize) {
  const size = Math.max(1, Math.floor(chunkSize));
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += size) {
    ranges.push({ fromBlock: start, toBlock: Math.min(start + size - 1, toBlock) });
  }
  return ranges;
}
