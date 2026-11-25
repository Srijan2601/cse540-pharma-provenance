/**
 * Formatting and parsing of the values people read and type: temperatures,
 * dates, addresses and file sizes.
 *
 * The contract and the documents store temperatures as integers in tenths of
 * a degree Celsius and times as Unix seconds. This module is the only place
 * that converts between those and text, so every screen shows them the same
 * way.
 *
 * Calendar dates (manufacture and expiry date) are stored as midnight UTC of
 * that day, the convention of the example documents in docs/schemas/. They are
 * therefore formatted in UTC: formatting them in the viewer's time zone would
 * show the previous day to everyone west of Greenwich.
 */

/** One locale for the whole English-language interface, so wording does not vary by browser. */
const LOCALE = "en-US";

/** Smallest and largest value of the contract's int16 temperature fields. */
const INT16_MIN = -32768;
const INT16_MAX = 32767;

/**
 * A temperature in words.
 * @param {number} tenthsC tenths of a degree Celsius, for example 54
 * @returns {string} for example "5.4 °C"
 */
export function formatTemperature(tenthsC) {
  return `${(tenthsC / 10).toFixed(1)} °C`;
}

/**
 * An allowed temperature range in words.
 * @param {number} minTenthsC
 * @param {number} maxTenthsC
 * @returns {string} for example "2.0 °C to 8.0 °C"
 */
export function formatTemperatureRange(minTenthsC, maxTenthsC) {
  return `${formatTemperature(minTenthsC)} to ${formatTemperature(maxTenthsC)}`;
}

/**
 * Parse a temperature typed in degrees Celsius into the contract's unit.
 *
 * Accepts an optional sign, digits and at most one decimal ("2", "-20", "8.5").
 * More decimals are rejected instead of rounded, because the registered range
 * decides when a lot is flagged and must be exactly what the person typed.
 *
 * @param {string} text
 * @returns {number|null} tenths of a degree, or null when the text is not a temperature the contract can store
 */
export function parseTemperature(text) {
  const match = /^([+-]?)(\d{1,4})(?:\.(\d))?$/.exec(String(text).trim());
  if (!match) return null;
  const magnitude = Number(match[2]) * 10 + Number(match[3] ?? 0);
  const tenths = match[1] === "-" ? -magnitude : magnitude;
  // Object.is tells -0 apart from 0; "-0" must become plain zero.
  const value = Object.is(tenths, -0) ? 0 : tenths;
  return value >= INT16_MIN && value <= INT16_MAX ? value : null;
}

/**
 * A point in time, in the viewer's own time zone.
 * @param {number} unixSeconds
 * @param {{ timeZone?: string }} [options] a fixed time zone (tests use "UTC"); default: the browser's
 * @returns {string} for example "Nov 25, 2026, 2:05 PM"
 */
export function formatDateTime(unixSeconds, { timeZone } = {}) {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short", timeZone }).format(
    new Date(unixSeconds * 1000),
  );
}

/**
 * A point in time without the year, for places with little room such as the
 * ends of the chart's time axis.
 * @param {number} unixSeconds
 * @param {{ timeZone?: string }} [options] a fixed time zone (tests use "UTC"); default: the browser's
 * @returns {string} for example "Nov 25, 2:05 PM"
 */
export function formatShortDateTime(unixSeconds, { timeZone } = {}) {
  return new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(
    new Date(unixSeconds * 1000),
  );
}

/**
 * A calendar date stored as midnight UTC (see the note at the top of this file).
 * @param {number} unixSeconds
 * @returns {string} for example "Nov 25, 2026"
 */
export function formatDate(unixSeconds) {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(unixSeconds * 1000));
}

/**
 * Convert the value of an <input type="date"> to Unix seconds at midnight UTC.
 * @param {string} text "YYYY-MM-DD"
 * @returns {number|null} null when the text is not a real calendar date
 */
export function dateInputToUnix(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC silently rolls an impossible date over (31 February becomes 3 March), so check the round trip.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Math.floor(date.getTime() / 1000);
}

/**
 * Today's date in the viewer's time zone, in the format of an <input type="date">.
 * @param {Date} [now] the current time (tests pass a fixed one)
 * @returns {string} "YYYY-MM-DD"
 */
export function todayAsDateInput(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Shorten an address for display: the first and last characters identify it
 * well enough on screen, and the full value stays available as a tooltip.
 * @param {string} address 0x + 40 hex digits
 * @returns {string} for example "0x7099…79C8"
 */
export function shortAddress(address) {
  const text = String(address);
  return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
}

/**
 * A file size in words.
 * @param {number} bytes
 * @returns {string} for example "483 bytes" or "12.4 KB"
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Turn a kebab-case identifier from a document ("certificate-of-analysis")
 * into words ("certificate of analysis").
 * @param {string} kind
 * @returns {string}
 */
export function kebabToWords(kind) {
  return String(kind).replaceAll("-", " ");
}
