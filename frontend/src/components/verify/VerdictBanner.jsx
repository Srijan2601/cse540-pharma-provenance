/**
 * The verdict of the verify page: one banner that answers "can I trust this
 * lot?" in plain words, followed by neutral notes.
 *
 * The rules that decide the verdict are in lib/verdict.js. This component
 * only presents it. Each level has its own icon and its own wording, so the
 * answer never depends on telling red from green.
 */

import { Icon } from "../Icon.jsx";
import { Notice } from "../Notice.jsx";

/** Icon per verdict level. */
const ICONS = { verified: "check", problem: "warning", danger: "stop", checking: "clock" };

/**
 * @param {{ verdict: import("../../lib/verdict.js").Verdict }} props
 */
export function VerdictBanner({ verdict }) {
  return (
    <div className="stack-small">
      {/* aria-live: the verdict changes without a reload when an excursion or a recall is recorded. */}
      <section className={`verdict verdict--${verdict.level}`} aria-labelledby="verdict-title" aria-live="polite">
        <span className="verdict__icon">
          <Icon name={ICONS[verdict.level]} size={44} />
        </span>
        <div className="verdict__text">
          <h2 id="verdict-title" className="verdict__title">
            {verdict.title}
          </h2>
          <p className="verdict__detail">{verdict.detail}</p>
        </div>
      </section>
      {verdict.notes.map((note) => (
        <Notice key={note} tone="info" title="Please note">
          <p>{note}</p>
        </Notice>
      ))}
    </div>
  );
}
