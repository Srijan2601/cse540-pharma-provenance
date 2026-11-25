/**
 * useFileChecks: download a set of files and compare each with its recorded
 * fingerprint, reporting results as they arrive.
 *
 * The verify page uses it for every document of a lot; the home page and the
 * dashboard use it for the lot metadata, to show product names. A file that
 * could not be fetched is tried again whenever `retryToken` changes (the pages
 * pass the time of their latest chain refresh), so files appear by themselves
 * once the file service is started.
 */

import { useEffect, useState } from "react";

import { checkFile } from "../chain/files.js";
import { fileKey } from "../lib/lotDocuments.js";

/**
 * @param {{ cid: string, contentHash: string }[]} refs  the files to check; may contain duplicates
 * @param {unknown} retryToken                           change it to retry files that were unavailable
 * @returns {Record<string, import("../chain/files.js").FileCheck>} results by fileKey(ref); a file whose
 *          check has not finished has no entry yet
 */
export function useFileChecks(refs, retryToken) {
  const [results, setResults] = useState({});
  // The effect depends on which files are wanted, not on the identity of the array the caller built.
  const wanted = [...new Set(refs.map(fileKey))].sort().join(",");

  useEffect(() => {
    let cancelled = false;
    for (const ref of refs) {
      const key = fileKey(ref);
      // checkFile remembers finished checks, so asking again for a file that matched costs nothing.
      checkFile(ref).then((result) => {
        if (cancelled) return;
        setResults((previous) => (previous[key]?.status === result.status ? previous : { ...previous, [key]: result }));
      });
    }
    return () => {
      cancelled = true;
    };
    // `refs` is represented by `wanted`: listing the array itself would re-run the effect on every render.
  }, [wanted, retryToken]);

  return results;
}
