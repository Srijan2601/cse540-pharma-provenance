/**
 * usePolling: run an asynchronous read now, and again every few seconds.
 *
 * Every page that shows chain state uses it, so an accepted hand-off, an
 * excursion reported by the oracle or a recall appears without reloading. The
 * app has no push channel on purpose: polling a JSON-RPC endpoint needs no
 * extra service and works the same on a local node and a public one.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * @template T
 * @param {() => Promise<T>} task      the read to repeat. It must be stable between renders
 *                                     (wrap it in useCallback or useMemo): a new function restarts the polling.
 * @param {number} intervalMs          pause between the end of one read and the start of the next
 * @returns {{ data: T|undefined, error: unknown, loading: boolean, refresh: () => Promise<void> }}
 *   `data` is the latest successful result (kept when a later read fails, so a hiccup does not blank
 *   the page); `error` is the failure of the latest read, or null; `loading` is true until the first
 *   read has finished; `refresh` reads again immediately and resolves when that read is done.
 */
export function usePolling(task, intervalMs) {
  const [state, setState] = useState({ data: undefined, error: null, loading: true });
  const runNow = useRef(async () => {});

  useEffect(() => {
    let stopped = false;
    let timer = null;
    /** The read in progress, if any. Reads never overlap: a refresh during a read waits for it and then reads again. */
    let inFlight = null;

    setState({ data: undefined, error: null, loading: true });

    const read = async () => {
      clearTimeout(timer);
      try {
        const data = await task();
        if (!stopped) setState({ data, error: null, loading: false });
      } catch (error) {
        if (!stopped) setState((previous) => ({ ...previous, error, loading: false }));
      }
      if (!stopped) timer = setTimeout(run, intervalMs);
    };

    const run = () => {
      // Chaining after the read in progress guarantees the caller sees state that is newer than its request.
      inFlight = (inFlight ?? Promise.resolve()).then(() => (stopped ? undefined : read()));
      return inFlight;
    };

    runNow.current = run;
    run();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [task, intervalMs]);

  const refresh = useCallback(() => runNow.current(), []);
  return { ...state, refresh };
}
