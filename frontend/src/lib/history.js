/**
 * Rebuild a lot's history from its events.
 *
 * The contract stores only a lot's current state; everything that happened to
 * it is in the events it emitted (design decision O6). replayHistory takes
 * those events and replays the lot's state machine over them. It returns
 *
 *   - the timeline shown on the verify page, oldest first;
 *   - every document the events refer to (all sensor logs, all certificates),
 *     because the contract itself keeps only the latest of each;
 *   - the excursion and the recall, if any, with the details the verdict needs;
 *   - the status and custodian the events add up to. The verify page compares
 *     them with what verifyBatch returns: if they differ, the history it shows
 *     is incomplete.
 *
 * Pure: no network, no React. The chain layer (src/chain/history.js) turns
 * raw logs into the LotEvent objects described below.
 */

import { roleLabel, Status, statusLabel } from "./constants.js";
import { formatTemperature, shortAddress } from "./format.js";

/**
 * @typedef {object} LotEvent
 * @property {string} name          event name, for example "TransferInitiated"
 * @property {Record<string, any>} args  the event's arguments by name, as plain values: numbers for ids,
 *                                  statuses, temperatures and times; strings for addresses, hashes and text
 * @property {number} blockNumber
 * @property {number} logIndex      position of the log in its block
 * @property {number} timestamp     timestamp of the block, Unix seconds
 */

/**
 * @typedef {object} TimelineEntry
 * @property {string} key           unique and stable: block number and log index
 * @property {string} type          the event name
 * @property {number} at            block timestamp, Unix seconds
 * @property {number} statusAfter   the lot's status once this event was applied
 * @property {Record<string, any>} data  what describeEntry needs to write the sentence
 */

/**
 * @typedef {object} LotHistory
 * @property {TimelineEntry[]} entries
 * @property {number|null} status             null when there are no events
 * @property {string|null} manufacturer
 * @property {string|null} custodian
 * @property {string|null} pendingCustodian   recipient of an open hand-off, or null
 * @property {{ index: number, cid: string, contentHash: string, at: number, isExcursion: boolean }[]} sensorLogs
 * @property {{ cid: string, contentHash: string, regulator: string, at: number }[]} certificates
 * @property {{ readingTenthsC: number, observedAt: number, logIndex: number, at: number }|null} excursion
 * @property {{ reason: string, regulator: string, at: number }|null} recall
 */

/**
 * Replay a lot's events.
 *
 * @param {LotEvent[]} events the lot's events in any order; they are sorted by block and log index here
 * @returns {LotHistory}
 */
export function replayHistory(events) {
  /** @type {LotHistory} */
  const history = {
    entries: [],
    status: null,
    manufacturer: null,
    custodian: null,
    pendingCustodian: null,
    sensorLogs: [],
    certificates: [],
    excursion: null,
    recall: null,
  };
  // cancelTransfer puts a lot back to the status it had before the hand-off was opened (Created or Stored).
  let statusBeforeHandOff = Status.Created;
  // Once a hand-off has been accepted the lot has left the factory, so whoever opens the next one is a distributor.
  let handOffsAccepted = 0;

  const ordered = [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  for (const event of ordered) {
    const { args } = event;
    /** Role of the organization holding the lot at this point; only a manufacturer or a distributor opens or cancels a hand-off. */
    const holderRole = handOffsAccepted === 0 ? "MANUFACTURER" : "DISTRIBUTOR";
    let data;

    switch (event.name) {
      case "BatchRegistered":
        history.status = Status.Created;
        history.manufacturer = args.manufacturer;
        history.custodian = args.manufacturer;
        data = { manufacturer: args.manufacturer };
        break;

      case "TransferInitiated":
        statusBeforeHandOff = history.status ?? Status.Created;
        history.status = Status.InTransit;
        history.pendingCustodian = args.to;
        data = { from: args.from, fromRole: holderRole, to: args.to };
        break;

      case "CustodyTransferred":
        history.status = Status.Stored;
        history.custodian = args.to;
        history.pendingCustodian = null;
        data = { from: args.from, fromRole: holderRole, to: args.to };
        handOffsAccepted += 1;
        break;

      case "TransferCancelled":
        history.status = statusBeforeHandOff;
        history.pendingCustodian = null;
        data = { from: args.from, fromRole: holderRole, to: args.to };
        break;

      case "StatusUpdated":
        history.status = args.newStatus;
        data = { by: args.by, previousStatus: args.previousStatus, newStatus: args.newStatus };
        break;

      case "CertificateIssued":
        history.certificates.push({ cid: args.cid, contentHash: args.contentHash, regulator: args.regulator, at: event.timestamp });
        data = { regulator: args.regulator };
        break;

      case "SensorLogAnchored":
        history.sensorLogs.push({
          index: args.logIndex,
          cid: args.cid,
          contentHash: args.contentHash,
          at: event.timestamp,
          isExcursion: false,
        });
        data = { logIndex: args.logIndex };
        break;

      case "ExcursionReported":
        // The log that contains the excursion is not also emitted as SensorLogAnchored, so it is recorded here.
        history.sensorLogs.push({
          index: args.logIndex,
          cid: args.logCid,
          contentHash: args.logContentHash,
          at: event.timestamp,
          isExcursion: true,
        });
        history.excursion = {
          readingTenthsC: args.readingTenthsC,
          observedAt: args.observedAt,
          logIndex: args.logIndex,
          at: event.timestamp,
        };
        // Entering Compromised or Recalled closes any open hand-off (contract invariant I2).
        history.status = Status.Compromised;
        history.pendingCustodian = null;
        data = { readingTenthsC: args.readingTenthsC, logIndex: args.logIndex };
        break;

      case "BatchRecalled":
        history.recall = { reason: args.reason, regulator: args.regulator, at: event.timestamp };
        history.status = Status.Recalled;
        history.pendingCustodian = null;
        data = { regulator: args.regulator, reason: args.reason };
        break;

      default:
        // Not a registry event of this lot (for example a role event); it has no place in the timeline.
        continue;
    }

    history.entries.push({
      key: `${event.blockNumber}-${event.logIndex}`,
      type: event.name,
      at: event.timestamp,
      statusAfter: /** @type {number} */ (history.status),
      data,
    });
  }
  return history;
}

/**
 * Name an organization the way the timeline shows it: its role and its short address.
 *
 * @param {string} address
 * @param {string|null} certainRole   the role key the contract's rules guarantee for this party in this
 *                                    event (only a regulator can recall, for example), or null when the
 *                                    event allows more than one role
 * @param {Record<string, string[]>} [rolesByAddress] roles each address holds on-chain right now; used when
 *                                    the event alone does not settle the role (the recipient of a hand-off
 *                                    is a distributor or a pharmacy)
 * @returns {string} for example "Distributor 0x3C44…93BC"
 */
export function partyName(address, certainRole, rolesByAddress = {}) {
  const role = certainRole ?? (rolesByAddress[address] ?? []).find((key) => key === "DISTRIBUTOR" || key === "RETAILER") ?? null;
  return `${roleLabel(role)} ${shortAddress(address)}`;
}

/**
 * Write a timeline entry in words.
 *
 * @param {TimelineEntry} entry
 * @param {Record<string, string[]>} [rolesByAddress] see partyName
 * @returns {{ title: string, sentence: string, isWarning: boolean }}
 *   `isWarning` marks the two events that make a lot unusable, so the page can flag them with an icon.
 */
export function describeEntry(entry, rolesByAddress = {}) {
  const { data } = entry;
  const name = (address, certainRole = null) => partyName(address, certainRole, rolesByAddress);

  switch (entry.type) {
    case "BatchRegistered":
      return plain("Lot registered", `${name(data.manufacturer, "MANUFACTURER")} registered the lot. Status: created.`);
    case "TransferInitiated":
      return plain("Hand-off started", `${name(data.from, data.fromRole)} offered the lot to ${name(data.to)}. Status: in transit.`);
    case "CustodyTransferred":
      return plain(
        "Hand-off accepted",
        `${name(data.to)} accepted the lot from ${name(data.from, data.fromRole)} and now holds it. Status: stored.`,
      );
    case "TransferCancelled":
      return plain(
        "Hand-off cancelled",
        `${name(data.from, data.fromRole)} cancelled the hand-off to ${name(data.to)}. ` +
          `Status: back to ${statusLabel(entry.statusAfter).toLowerCase()}.`,
      );
    case "StatusUpdated":
      // markDelivered is a pharmacy function; every other status update is a distributor's updateStatus.
      return data.newStatus === Status.Delivered
        ? plain("Lot delivered", `${name(data.by, "RETAILER")} marked the lot as delivered.`)
        : plain(
            "Status updated",
            `${name(data.by, "DISTRIBUTOR")} changed the status from ${statusLabel(data.previousStatus).toLowerCase()} ` +
              `to ${statusLabel(data.newStatus).toLowerCase()}.`,
          );
    case "CertificateIssued":
      return plain("Certificate issued", `${name(data.regulator, "REGULATOR")} attached a certificate to the lot.`);
    case "SensorLogAnchored":
      return plain(`Temperature log ${data.logIndex} anchored`, `The IoT oracle anchored sensor log ${data.logIndex}.`);
    case "ExcursionReported":
      return {
        title: "Temperature excursion reported",
        sentence:
          `The IoT oracle reported a reading of ${formatTemperature(data.readingTenthsC)}, outside the allowed range ` +
          `(sensor log ${data.logIndex}). Status: compromised.`,
        isWarning: true,
      };
    case "BatchRecalled":
      return {
        title: "Lot recalled",
        sentence: `${name(data.regulator, "REGULATOR")} recalled the lot. Reason: ${data.reason}`,
        isWarning: true,
      };
    default:
      return plain(entry.type, "");
  }
}

/**
 * @param {string} title
 * @param {string} sentence
 * @returns {{ title: string, sentence: string, isWarning: boolean }}
 */
function plain(title, sentence) {
  return { title, sentence, isWarning: false };
}
