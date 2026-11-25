/**
 * Formatting of the two units every part of the project shares with the
 * contract: temperatures in tenths of a degree Celsius (int16) and times in
 * Unix seconds (uint64).
 *
 * The values stay integers everywhere in the code and in the documents; only
 * text meant for people (console lines, the excursion rule description) goes
 * through these helpers, so the same reading is always printed the same way.
 *
 * No Node-only imports: this file also runs in the browser.
 */

/** Lowest and highest temperature the contract's int16 can hold, in tenths of a degree C. */
export const INT16_MIN = -32768;
export const INT16_MAX = 32767;

/**
 * Write a temperature in degrees with one decimal: 54 -> "5.4", -205 -> "-20.5".
 * @param {number} tenthsC integer tenths of a degree Celsius
 * @returns {string}
 */
export function formatTenths(tenthsC) {
  // Dividing an integer by 10 and rounding to one decimal is exact for every int16 value.
  return (tenthsC / 10).toFixed(1);
}

/**
 * Write a temperature range the way the excursion rule quotes it: "2.0 C to 8.0 C".
 * @param {{ minTenthsC: number, maxTenthsC: number }} range
 * @returns {string}
 */
export function formatRange(range) {
  return `${formatTenths(range.minTenthsC)} C to ${formatTenths(range.maxTenthsC)} C`;
}

/**
 * Write a Unix time as an ISO 8601 UTC timestamp without milliseconds: "2026-11-25T17:03:11Z".
 * @param {number} unixSeconds
 * @returns {string}
 */
export function isoTime(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().replace(".000Z", "Z");
}

/**
 * Tell whether a value is a whole number the contract's int16 can hold.
 * @param {unknown} value
 * @returns {value is number}
 */
export function isInt16(value) {
  return Number.isInteger(value) && value >= INT16_MIN && value <= INT16_MAX;
}
