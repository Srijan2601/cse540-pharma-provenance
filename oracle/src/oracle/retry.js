/**
 * Bounded retry with exponential backoff, used by the oracle runner for the
 * calls that depend on a network: the RPC endpoint and a remote storage
 * backend.
 *
 * Only failures that are marked transient are retried (the endpoint was
 * unreachable, timed out or overloaded). A rejection by the contract, a
 * missing lot or an invalid document would fail identically the second time,
 * so those are passed straight to the caller.
 *
 * The retry is bounded on purpose: at most `attempts` tries and a few seconds
 * of waiting in total. The oracle processes its lots one after the other, so
 * an unbounded retry for one lot would starve all the others. When the tries
 * are used up, the last error is thrown and the runner reports it.
 *
 * The wait is injected (`sleep`), so tests run without real delays.
 */

import { setTimeout as delay } from "node:timers/promises";

import { StorageError, TransientChainError } from "../errors.js";

/** Default policy: 4 tries, waiting 0.5 s, 1 s and 2 s between them (3.5 s in total). */
export const DEFAULT_RETRY_POLICY = Object.freeze({ attempts: 4, baseDelayMs: 500, maxDelayMs: 4000 });

/**
 * Tell whether an error is worth a retry.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientError(error) {
  return error instanceof TransientChainError || (error instanceof StorageError && error.transient === true);
}

/**
 * Wait for a number of milliseconds, or until the signal aborts, whichever
 * comes first. It never rejects: a shutdown request simply ends the wait early.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export async function abortableSleep(ms, signal) {
  if (ms <= 0 || signal?.aborted) return;
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  }
}

/**
 * Run an operation, retrying transient failures.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation receives the attempt number, starting at 1
 * @param {object} [options]
 * @param {number} [options.attempts]      total tries, at least 1
 * @param {number} [options.baseDelayMs]   wait before the second try; doubles for each further try
 * @param {number} [options.maxDelayMs]    upper bound of a single wait
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @param {AbortSignal} [options.signal]   when aborted (shutdown), no further try is started
 * @param {(error: unknown) => boolean} [options.isRetryable]
 * @param {(info: { attempt: number, attempts: number, delayMs: number, error: unknown }) => void} [options.onRetry]
 *        called before each wait, so the caller can log the retry
 * @returns {Promise<T>} the operation's result
 * @throws the last error, when it is not retryable or the tries are used up
 */
export async function withRetry(
  operation,
  {
    attempts = DEFAULT_RETRY_POLICY.attempts,
    baseDelayMs = DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs = DEFAULT_RETRY_POLICY.maxDelayMs,
    sleep = abortableSleep,
    signal,
    isRetryable = isTransientError,
    onRetry,
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= attempts || signal?.aborted || !isRetryable(error)) {
        throw error;
      }
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      onRetry?.({ attempt, attempts, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}
