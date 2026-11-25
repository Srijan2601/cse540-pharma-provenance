/**
 * The numbers behind the temperature chart of the verify page.
 *
 *   collectReadings  verified sensor logs -> one list of readings in time order
 *   chartLayout      readings + allowed range -> scales, axis ticks and the
 *                    position of the shaded band, for a drawing area of a given size
 *
 * The chart component (components/verify/TemperatureChart.jsx) only turns this
 * layout into SVG elements. Keeping the arithmetic here makes it testable
 * without a browser.
 *
 * Temperatures are in tenths of a degree Celsius and times in Unix seconds,
 * as everywhere else in the app.
 */

/** Tick spacings to choose from, in tenths of a degree: 0.5, 1, 2, 5, 10, 20 and 50 °C. */
const TICK_STEPS = [5, 10, 20, 50, 100, 200, 500];
/** A value axis with more labels than this is harder to read, not easier. */
const MAX_TICKS = 6;
/** Time shown around a single reading, so one point does not sit on the edge of the chart. */
const LONE_READING_PADDING_SECONDS = 1800;

/**
 * @typedef {{ t: number, tenthsC: number }} Reading
 * @typedef {{ index: number, readings: Reading[] }} SensorLogReadings one verified log: its number and its readings
 */

/**
 * Put the readings of several sensor logs in time order.
 *
 * @param {SensorLogReadings[]} logs only logs whose file matched its fingerprint and passed its schema
 * @returns {{ segments: { index: number, points: Reading[] }[], points: (Reading & { logIndex: number })[] }}
 *   `segments` keeps each log's readings together, so the chart draws one line per log and does not
 *   pretend to know the temperature in the gap between two logs. `points` is every reading, oldest
 *   first, for the table.
 */
export function collectReadings(logs) {
  const segments = logs
    .filter((log) => log.readings.length > 0)
    .map((log) => ({ index: log.index, points: [...log.readings].sort((a, b) => a.t - b.t) }))
    .sort((a, b) => a.points[0].t - b.points[0].t);
  const points = segments
    .flatMap((segment) => segment.points.map((point) => ({ ...point, logIndex: segment.index })))
    .sort((a, b) => a.t - b.t);
  return { segments, points };
}

/**
 * Tell whether a reading is inside the allowed range. Both bounds are allowed
 * values, exactly as in the contract's reportExcursion check.
 * @param {number} tenthsC
 * @param {{ minTenthsC: number, maxTenthsC: number }} range
 * @returns {boolean}
 */
export function isWithinRange(tenthsC, range) {
  return tenthsC >= range.minTenthsC && tenthsC <= range.maxTenthsC;
}

/**
 * @typedef {object} ChartLayout
 * @property {{ left: number, right: number, top: number, bottom: number }} plot   edges of the drawing area in pixels
 * @property {(t: number) => number} x          time -> horizontal pixel position
 * @property {(tenthsC: number) => number} y    temperature -> vertical pixel position
 * @property {{ value: number, y: number }[]} yTicks   round temperatures to label on the value axis
 * @property {{ t: number, x: number }[]} xTicks       the first and the last moment, to label on the time axis
 * @property {{ y: number, height: number }} band      the shaded allowed range
 */

/**
 * Lay the chart out for a drawing surface of a given size.
 *
 * The value axis always shows the whole allowed range as well as every
 * reading (and the excursion reading, which is reported on-chain and is drawn
 * even if its log file could not be fetched), so "inside or outside the band"
 * can be read at a glance.
 *
 * @param {object} input
 * @param {Reading[]} input.points                                    readings to plot; may be empty
 * @param {{ minTenthsC: number, maxTenthsC: number }} input.range    the lot's allowed range
 * @param {Reading|null} [input.excursion]                            the reading reported as an excursion, if any
 * @param {number} input.width                                        width of the SVG in pixels
 * @param {number} input.height                                       height of the SVG in pixels
 * @param {{ left: number, right: number, top: number, bottom: number }} input.margin room for the axis labels
 * @returns {ChartLayout}
 */
export function chartLayout({ points, range, excursion = null, width, height, margin }) {
  const plotted = excursion ? [...points, excursion] : points;
  const plot = { left: margin.left, right: width - margin.right, top: margin.top, bottom: height - margin.bottom };

  // Value axis: cover the readings and the range, then widen to the next whole degree beyond half a degree of air.
  const values = [...plotted.map((point) => point.tenthsC), range.minTenthsC, range.maxTenthsC];
  const low = Math.floor((Math.min(...values) - 5) / 10) * 10;
  const high = Math.ceil((Math.max(...values) + 5) / 10) * 10;
  const y = (tenthsC) => plot.bottom - ((tenthsC - low) / (high - low)) * (plot.bottom - plot.top);

  const step = TICK_STEPS.find((candidate) => (high - low) / candidate <= MAX_TICKS) ?? TICK_STEPS.at(-1);
  const yTicks = [];
  for (let value = Math.ceil(low / step) * step; value <= high; value += step) {
    yTicks.push({ value, y: y(value) });
  }

  // Time axis: from the first to the last reading.
  const times = plotted.map((point) => point.t);
  let start = times.length > 0 ? Math.min(...times) : 0;
  let end = times.length > 0 ? Math.max(...times) : 1;
  if (start === end) {
    start -= LONE_READING_PADDING_SECONDS;
    end += LONE_READING_PADDING_SECONDS;
  }
  const x = (t) => plot.left + ((t - start) / (end - start)) * (plot.right - plot.left);

  return {
    plot,
    x,
    y,
    yTicks,
    xTicks: [
      { t: start, x: plot.left },
      { t: end, x: plot.right },
    ],
    band: { y: y(range.maxTenthsC), height: y(range.minTenthsC) - y(range.maxTenthsC) },
  };
}
