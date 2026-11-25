/**
 * Tests of the block-range paging used for event queries.
 */

import { describe, expect, it } from "vitest";

import { splitBlockRange } from "./blockRanges.js";

describe("splitBlockRange", () => {
  it("returns one range when the span fits in a page", () => {
    expect(splitBlockRange(1, 40, 50000)).toEqual([{ fromBlock: 1, toBlock: 40 }]);
  });

  it("splits a longer span into consecutive pages with a shorter last page", () => {
    expect(splitBlockRange(100, 125, 10)).toEqual([
      { fromBlock: 100, toBlock: 109 },
      { fromBlock: 110, toBlock: 119 },
      { fromBlock: 120, toBlock: 125 },
    ]);
  });

  it("covers every block exactly once", () => {
    const ranges = splitBlockRange(12345678, 12360000, 5000);
    expect(ranges[0].fromBlock).toBe(12345678);
    expect(ranges.at(-1).toBlock).toBe(12360000);
    for (let index = 1; index < ranges.length; index++) {
      expect(ranges[index].fromBlock).toBe(ranges[index - 1].toBlock + 1);
    }
    expect(ranges.every((range) => range.toBlock - range.fromBlock + 1 <= 5000)).toBe(true);
  });

  it("handles a single block", () => {
    expect(splitBlockRange(7, 7, 100)).toEqual([{ fromBlock: 7, toBlock: 7 }]);
  });

  it("returns nothing when there is no new block to read", () => {
    expect(splitBlockRange(8, 7, 100)).toEqual([]);
  });

  it("never loops forever on a nonsensical page size", () => {
    expect(splitBlockRange(1, 3, 0)).toHaveLength(3);
  });
});
