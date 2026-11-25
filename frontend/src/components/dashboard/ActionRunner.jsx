/**
 * Running dashboard actions one at a time and showing what became of them.
 *
 * Every button on the dashboard goes through `run`:
 *   - while an action is in progress, `busy` is true and every action button
 *     is disabled, so the same transaction cannot be sent twice;
 *   - a failure (a contract revert found by the simulation, a declined wallet
 *     request, the file service being down) is turned into one plain sentence;
 *   - afterwards the chain is read again, and only then is the result shown,
 *     so the message and the data on screen agree.
 *
 * The result is shown next to the thing that was acted on: each lot row and
 * each form places an <ActionOutcome> with its own `scope`. The re-read can
 * take that place away. For example, when the sender cancels a hand-off
 * shortly before the recipient clicks Accept, the simulation refuses the call
 * and the refreshed data drops the lot from "Incoming hand-offs", together
 * with the row that would have explained why. So every <ActionOutcome>
 * reports that it is on screen, and <UnplacedActionOutcome> shows a result
 * whose place is gone at the top of the dashboard instead.
 *
 * A result describes what one account just did, so the dashboard gives every
 * signed-in account its own provider (see pages/DashboardPage.jsx). A success
 * message also goes away by itself after a few seconds: it is worded about the
 * lot as it was right after the action ("the lot is in transit until..."), and
 * other organizations or the oracle may change the lot soon after. The row's
 * status badge and holder stay on screen and always show the current state.
 * Errors stay until the next action (or another account signs in), so they
 * can be read at leisure.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { explainError } from "../../lib/errors.js";
import { Notice } from "../Notice.jsx";

/** How long a success message stays on screen, in milliseconds: enough to read one or two sentences. */
const SUCCESS_VISIBLE_MS = 8000;

/**
 * @typedef {{ scope: string, tone: "progress"|"success"|"error", text: string }} Outcome
 * @typedef {object} Actions
 * @property {boolean} busy
 * @property {Outcome|null} outcome  the latest action's state
 * @property {<T>(scope: string, work: (report: (step: string) => void) => Promise<T>, successText: string | ((result: T) => string))
 *            => Promise<{ ok: boolean, result?: T }>} run
 * @property {(scope: string) => () => void} place  marks a scope as shown on screen; returns the function that unmarks it
 * @property {ReadonlyMap<string, number>} placedScopes how many <ActionOutcome> elements of each scope are on screen
 */

const ActionContext = createContext(/** @type {Actions|null} */ (null));

/**
 * @param {object} props
 * @param {() => Promise<unknown>} props.onSettled  re-reads the chain; called after every action, successful or not
 * @param {import("react").ReactNode} props.children
 */
export function ActionProvider({ onSettled, children }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(/** @type {Outcome|null} */ (null));
  // A count rather than a set: one lot can be listed twice (an account with two custody roles, or a regulator
  // who also holds lots), and removing one of those rows must not mark the other as gone.
  const [placedScopes, setPlacedScopes] = useState(() => /** @type {ReadonlyMap<string, number>} */ (new Map()));

  const place = useCallback((scope) => {
    setPlacedScopes((previous) => new Map(previous).set(scope, (previous.get(scope) ?? 0) + 1));
    return () =>
      setPlacedScopes((previous) => {
        const next = new Map(previous);
        const remaining = (next.get(scope) ?? 1) - 1;
        if (remaining > 0) next.set(scope, remaining);
        else next.delete(scope);
        return next;
      });
  }, []);

  const run = useCallback(
    async (scope, work, successText) => {
      setBusy(true);
      const report = (step) => setOutcome({ scope, tone: "progress", text: step });
      report("Checking with the blockchain");

      let settled;
      let result;
      try {
        result = await work(report);
        settled = { scope, tone: "success", text: typeof successText === "function" ? successText(result) : successText };
      } catch (error) {
        settled = { scope, tone: "error", text: explainError(error) };
      }
      try {
        await onSettled();
      } catch {
        // The pages keep polling; a failed refresh here only delays the update by a few seconds.
      }
      setOutcome(settled);
      setBusy(false);
      return settled.tone === "success" ? { ok: true, result } : { ok: false };
    },
    [onSettled],
  );

  // Any new outcome (the next action's progress) or unmounting cancels the timer, so it can only clear this success.
  useEffect(() => {
    if (outcome?.tone !== "success") return undefined;
    const timer = setTimeout(() => setOutcome(null), SUCCESS_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  const actions = useMemo(() => ({ busy, outcome, run, place, placedScopes }), [busy, outcome, run, place, placedScopes]);
  return <ActionContext.Provider value={actions}>{children}</ActionContext.Provider>;
}

/**
 * @returns {Actions}
 */
export function useActions() {
  const actions = useContext(ActionContext);
  if (actions === null) throw new Error("useActions must be used inside <ActionProvider>.");
  return actions;
}

/**
 * Shows the latest action's progress or result if it belongs to `scope`.
 * @param {{ scope: string }} props
 */
export function ActionOutcome({ scope }) {
  const { outcome, place } = useActions();
  // Registered for as long as this element is on screen, whether or not it currently shows anything.
  useEffect(() => place(scope), [place, scope]);
  if (outcome === null || outcome.scope !== scope) return null;
  return <OutcomeMessage outcome={outcome} />;
}

/**
 * Shows the latest action's progress or result when no <ActionOutcome> of its
 * scope is on screen any more, typically because the lot it was about has
 * left this account's lists. The dashboard places it once, above the panels.
 */
export function UnplacedActionOutcome() {
  const { outcome, placedScopes } = useActions();
  const box = useRef(/** @type {HTMLDivElement|null} */ (null));
  const shown = outcome !== null && !placedScopes.has(outcome.scope);

  useEffect(() => {
    // The person was looking at the row that has just disappeared, possibly far down the page,
    // so the message is brought into view ("nearest" leaves the page alone if it is visible already).
    if (shown) box.current?.scrollIntoView({ block: "nearest" });
  }, [shown, outcome]);

  if (!shown) return null;
  return (
    <div ref={box}>
      <OutcomeMessage outcome={outcome} />
    </div>
  );
}

/**
 * One outcome: a spinner line while the action runs, then a notice.
 * @param {{ outcome: Outcome }} props
 */
function OutcomeMessage({ outcome }) {
  if (outcome.tone === "progress") {
    return (
      <p className="button-row muted" role="status">
        <span className="spinner" aria-hidden="true" />
        {outcome.text}…
      </p>
    );
  }
  return (
    <Notice tone={outcome.tone} live>
      <p>{outcome.text}</p>
    </Notice>
  );
}
