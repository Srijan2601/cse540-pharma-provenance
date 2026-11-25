/**
 * The custody timeline of the verify page: everything that happened to the
 * lot, oldest first, rebuilt from the contract's events.
 *
 * Dates are block timestamps, the times the chain itself vouches for. The
 * wording of each entry comes from lib/history.js; the two events that make a
 * lot unusable (an excursion and a recall) carry a warning icon and the word
 * "Warning" for screen readers.
 */

import { formatDateTime } from "../../lib/format.js";
import { describeEntry } from "../../lib/history.js";
import { Icon } from "../Icon.jsx";

/** A shortened address as lib/format.js writes it, for example "0x7099…79C8". */
const SHORT_ADDRESS = /(0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4})/;

/**
 * A timeline sentence, with each shortened address kept on one line. Browsers
 * may break a line after the "…" inside an address, which makes it hard to read.
 * @param {{ text: string }} props
 */
function Sentence({ text }) {
  // split() with a capturing group puts the matched addresses at the odd positions.
  return text.split(SHORT_ADDRESS).map((part, position) =>
    position % 2 === 1 ? (
      <span key={position} className="nowrap">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * @param {object} props
 * @param {import("../../lib/history.js").TimelineEntry[]} props.entries oldest first
 * @param {Record<string, string[]>} props.rolesByAddress on-chain roles of the addresses in the history
 */
export function Timeline({ entries, rolesByAddress }) {
  return (
    <section className="card" aria-labelledby="timeline-title">
      <h2 id="timeline-title">History</h2>
      <p className="muted">Every step was recorded on the blockchain by the organization that took it, and cannot be edited afterwards.</p>
      <ol className="timeline">
        {entries.map((entry) => {
          const { title, sentence, isWarning } = describeEntry(entry, rolesByAddress);
          return (
            <li key={entry.key} className={`timeline__item${isWarning ? " timeline__item--warning" : ""}`}>
              <span className="timeline__marker">{isWarning ? <Icon name="warning" size={14} /> : null}</span>
              <div className="timeline__body">
                <p className="timeline__time">
                  <time dateTime={new Date(entry.at * 1000).toISOString()}>{formatDateTime(entry.at)}</time>
                </p>
                <h3 className="timeline__title">
                  {isWarning ? <span className="visually-hidden">Warning: </span> : null}
                  {title}
                </h3>
                <p className="timeline__sentence">
                  <Sentence text={sentence} />
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
