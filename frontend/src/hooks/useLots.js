/**
 * useLots: every lot in the registry, refreshed every few seconds, with the
 * product name of each lot once its metadata file has been fetched and checked.
 *
 * The home page and every dashboard panel build on this one list.
 */

import { useCallback, useMemo } from "react";

import { readAllLots, readRoles } from "../chain/registry.js";
import { belongsToLot, readDocument } from "../lib/documents.js";
import { fileKey } from "../lib/lotDocuments.js";
import { useFileChecks } from "./useFileChecks.js";
import { usePolling } from "./usePolling.js";

/** Shared empty values, so "no data yet" does not look like new data on every render. */
const EMPTY = Object.freeze([]);
const EMPTY_ROLES = Object.freeze({});

/**
 * @typedef {object} LotSummary what a list shows about a lot beyond its on-chain record
 * @property {string|null} productName  from the verified lot metadata; null while loading or when unusable
 * @property {string|null} lotNumber    the manufacturer's lot number, likewise
 * @property {"pending"|"match"|"mismatch"|"unavailable"} metadataStatus result of the metadata's fingerprint check
 */

/**
 * @param {import("../lib/networks.js").Network} network
 * @returns {{
 *   lots: import("../chain/registry.js").Lot[],
 *   summaries: Record<number, LotSummary>,
 *   rolesByAddress: Record<string, string[]>,
 *   loading: boolean,
 *   error: unknown,
 *   refresh: () => Promise<void>
 * }}
 *   `rolesByAddress` covers every current and pending holder, so lists can say "Pharmacy 0x…".
 */
export function useLots(network) {
  const read = useCallback(async () => {
    const lots = await readAllLots(network);
    const holders = lots.flatMap((lot) => (lot.pendingCustodian ? [lot.custodian, lot.pendingCustodian] : [lot.custodian]));
    return { lots, rolesByAddress: await readRoles(network, holders), readAt: Date.now() };
  }, [network]);
  const { data, loading, error, refresh } = usePolling(read, network.pollMs);

  const lots = data?.lots ?? EMPTY;
  const metadataRefs = useMemo(() => lots.map((lot) => lot.metadata), [lots]);
  const checks = useFileChecks(metadataRefs, data?.readAt);

  const summaries = useMemo(() => {
    /** @type {Record<number, LotSummary>} */
    const byLot = {};
    for (const lot of lots) {
      const check = checks[fileKey(lot.metadata)];
      const summary = { productName: null, lotNumber: null, metadataStatus: check?.status ?? "pending" };
      if (check?.status === "match") {
        // Names are shown only from a file that matches its fingerprint, is valid lot metadata and is about this lot.
        const { document } = readDocument(check.bytes, "lot-metadata");
        const context = { chainId: network.chainId, registry: network.registry, lotId: lot.id, productHash: lot.productHash };
        if (document && belongsToLot(document, context) === null) {
          summary.productName = document.productName;
          summary.lotNumber = document.lotNumber;
        }
      }
      byLot[lot.id] = summary;
    }
    return byLot;
  }, [lots, checks, network]);

  return { lots, summaries, rolesByAddress: data?.rolesByAddress ?? EMPTY_ROLES, loading, error, refresh };
}
