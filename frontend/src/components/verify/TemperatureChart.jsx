/**
 * The temperature history of the verify page: one line chart of every reading
 * in the lot's verified sensor logs, and the same readings as a table.
 *
 * What the chart shows:
 *   - the allowed range as a shaded band, labelled in words;
 *   - the readings as a line, one stroke per sensor log, so a gap between two
 *     logs is not bridged with an invented line;
 *   - the reading that was reported on-chain as an excursion, as a diamond
 *     with its value written next to it (shape and label, not only colour).
 *
 * The arithmetic is in lib/temperature.js. The SVG is drawn at the pixel size
 * of its container instead of being scaled, so axis labels keep a readable
 * size on a phone. The table carries the same data for screen readers and for
 * anyone who wants the exact numbers.
 */

import { useEffect, useState } from "react";

import { formatDateTime, formatShortDateTime, formatTemperature, formatTemperatureRange } from "../../lib/format.js";
import { chartLayout, isWithinRange } from "../../lib/temperature.js";

const HEIGHT = 240;
/** Room around the plot for the axis labels, in pixels. */
const MARGIN = { left: 44, right: 14, top: 14, bottom: 30 };
/** Half the diagonal of the excursion diamond, in pixels. */
const DIAMOND = 7;

/**
 * Follow the width of an element, so the chart can be redrawn at its real size.
 * @returns {[(element: HTMLElement|null) => void, number]} a callback ref for the element, and its width in pixels
 */
function useElementWidth() {
  // A callback ref (state, not useRef): the container only exists once the lot has a sensor log,
  // and the observer must attach whenever it appears.
  const [element, setElement] = useState(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (element === null) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}

/**
 * The chart itself.
 * @param {object} props
 * @param {number} props.width
 * @param {{ segments: { index: number, points: { t: number, tenthsC: number }[] }[],
 *           points: { t: number, tenthsC: number, logIndex: number }[] }} props.readings
 * @param {{ minTenthsC: number, maxTenthsC: number }} props.range
 * @param {{ t: number, tenthsC: number }|null} props.excursion
 * @param {string} props.summary text alternative of the chart
 */
function Chart({ width, readings, range, excursion, summary }) {
  const layout = chartLayout({ points: readings.points, range, excursion, width, height: HEIGHT, margin: MARGIN });
  const { plot, x, y } = layout;
  const excursionX = excursion ? x(excursion.t) : 0;
  const excursionY = excursion ? y(excursion.tenthsC) : 0;
  // The label sits left of the marker when the marker is in the right half, so it never leaves the chart.
  const labelOnLeft = excursionX > (plot.left + plot.right) / 2;

  return (
    <svg className="chart" width={width} height={HEIGHT} role="img" aria-label={summary}>
      {/* Allowed range: a light wash with a hairline at each bound. */}
      <rect className="chart__band" x={plot.left} y={layout.band.y} width={plot.right - plot.left} height={layout.band.height} />
      <line className="chart__band-edge" x1={plot.left} x2={plot.right} y1={layout.band.y} y2={layout.band.y} />
      <line
        className="chart__band-edge"
        x1={plot.left}
        x2={plot.right}
        y1={layout.band.y + layout.band.height}
        y2={layout.band.y + layout.band.height}
      />
      <text className="chart__label" x={plot.left + 6} y={layout.band.y + layout.band.height - 6}>
        Allowed range
      </text>

      {/* Value axis: a few round temperatures with hairline grid lines. */}
      {layout.yTicks.map((tick) => (
        <g key={tick.value}>
          <line className="chart__grid" x1={plot.left} x2={plot.right} y1={tick.y} y2={tick.y} />
          <text className="chart__tick" x={plot.left - 6} y={tick.y} textAnchor="end" dominantBaseline="middle">
            {(tick.value / 10).toFixed(tick.value % 10 === 0 ? 0 : 1)} °C
          </text>
        </g>
      ))}

      {/* Time axis: the first and the last moment. */}
      <line className="chart__axis" x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} />
      {layout.xTicks.map((tick, position) => (
        <text key={tick.t} className="chart__tick" x={tick.x} y={plot.bottom + 18} textAnchor={position === 0 ? "start" : "end"}>
          {formatShortDateTime(tick.t)}
        </text>
      ))}

      {readings.segments.map((segment) =>
        segment.points.length === 1 ? (
          <circle key={segment.index} className="chart__dot" cx={x(segment.points[0].t)} cy={y(segment.points[0].tenthsC)} r="3" />
        ) : (
          <polyline
            key={segment.index}
            className="chart__line"
            points={segment.points.map((point) => `${x(point.t).toFixed(1)},${y(point.tenthsC).toFixed(1)}`).join(" ")}
          />
        ),
      )}

      {excursion ? (
        <g>
          <path
            className="chart__excursion"
            d={`M${excursionX} ${excursionY - DIAMOND} L${excursionX + DIAMOND} ${excursionY} L${excursionX} ${excursionY + DIAMOND} L${excursionX - DIAMOND} ${excursionY} Z`}
          />
          <text
            className="chart__label chart__label--strong"
            x={excursionX + (labelOnLeft ? -DIAMOND - 6 : DIAMOND + 6)}
            y={excursionY}
            textAnchor={labelOnLeft ? "end" : "start"}
            dominantBaseline="middle"
          >
            Excursion: {formatTemperature(excursion.tenthsC)}
          </text>
        </g>
      ) : null}

      {/* Invisible, generously sized hover targets: resting the pointer on a reading shows its time and value. */}
      {readings.points.map((point) => (
        <circle key={`${point.logIndex}-${point.t}`} className="chart__hit" cx={x(point.t)} cy={y(point.tenthsC)} r="8">
          <title>{`${formatDateTime(point.t)}: ${formatTemperature(point.tenthsC)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

/**
 * @param {object} props
 * @param {{ segments: object[], points: { t: number, tenthsC: number, logIndex: number }[] }} props.readings from collectReadings
 * @param {{ minTenthsC: number, maxTenthsC: number }} props.range the lot's allowed range, from the chain
 * @param {{ readingTenthsC: number, observedAt: number }|null} props.excursion the on-chain excursion report, if any
 * @param {number} props.logCount   how many sensor logs the lot has
 * @param {number} props.logsUsable how many of them matched their fingerprint and could be read
 */
export function TemperatureHistory({ readings, range, excursion, logCount, logsUsable }) {
  const [containerRef, width] = useElementWidth();
  const marked = excursion ? { t: excursion.observedAt, tenthsC: excursion.readingTenthsC } : null;
  const { points } = readings;
  const rangeText = formatTemperatureRange(range.minTenthsC, range.maxTenthsC);

  let summary = `Allowed range ${rangeText}. `;
  if (points.length > 0) {
    const values = points.map((point) => point.tenthsC);
    summary +=
      `${points.length} readings from ${formatDateTime(points[0].t)} to ${formatDateTime(points.at(-1).t)}, ` +
      `between ${formatTemperature(Math.min(...values))} and ${formatTemperature(Math.max(...values))}.`;
  }
  if (marked) summary += ` A reading of ${formatTemperature(marked.tenthsC)} was reported as an excursion.`;

  return (
    <section className="card" aria-labelledby="temperature-title">
      <h2 id="temperature-title">Temperature</h2>
      {logCount === 0 ? (
        <p className="empty">No temperature log has been recorded for this lot yet. The allowed range is {rangeText}.</p>
      ) : (
        <>
          <p className="muted">
            Readings from {logsUsable} of {logCount} sensor {logCount === 1 ? "log" : "logs"} anchored by the IoT oracle. The shaded
            band is the allowed range, {rangeText}.
          </p>
          <div ref={containerRef} className="chart-frame">
            {width > 0 && (points.length > 0 || marked) ? (
              <Chart width={width} readings={readings} range={range} excursion={marked} summary={summary} />
            ) : null}
          </div>
          {points.length > 0 ? (
            <details className="document__details">
              <summary>Show the {points.length} readings as a table</summary>
              <table className="table table--compact small">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Temperature</th>
                    <th scope="col">In allowed range?</th>
                  </tr>
                </thead>
                <tbody>
                  {points.map((point) => {
                    const reported = marked !== null && marked.t === point.t && marked.tenthsC === point.tenthsC;
                    return (
                      <tr key={`${point.logIndex}-${point.t}`}>
                        <td className="nowrap">{formatShortDateTime(point.t)}</td>
                        <td>{formatTemperature(point.tenthsC)}</td>
                        <td>
                          {isWithinRange(point.tenthsC, range) ? "Yes" : <strong>No, out of range</strong>}
                          {reported ? <strong> (reported as the excursion)</strong> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </details>
          ) : (
            <p className="muted">The sensor log files could not be read, so no readings can be shown.</p>
          )}
        </>
      )}
    </section>
  );
}
